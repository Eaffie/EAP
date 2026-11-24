package com.admin.service.impl;

import com.admin.common.dto.DnsAccountDto;
import com.admin.common.dto.DnsPointDto;
import com.admin.common.dto.DnsRecordDto;
import com.admin.common.lang.R;
import com.admin.common.utils.AESCrypto;
import com.admin.entity.CfAccount;
import com.admin.mapper.CfAccountMapper;
import com.admin.service.DnsService;
import com.alibaba.fastjson.JSON;
import com.alibaba.fastjson.JSONArray;
import com.alibaba.fastjson.JSONObject;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.extension.service.impl.ServiceImpl;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestTemplate;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * <p>
 * DNS 管理服务实现(Cloudflare API v4)
 * </p>
 *
 * 只用面板已有的 RestTemplate,不引新依赖。所有 Cloudflare 返回 success=false 的情况
 * 都把 errors[0].message 原样抛给前端 —— 橙云(proxied)记录的限制(比如 CNAME 到根域、
 * TTL 值不对)只有 Cloudflare 自己说得清,吞掉换成笼统文案等于让人上服务器翻日志。
 *
 * @since 2026-11-25
 */
@Slf4j
@Service
public class DnsServiceImpl extends ServiceImpl<CfAccountMapper, CfAccount> implements DnsService {

    private static final String API_BASE = "https://api.cloudflare.com/client/v4";

    /** 账号状态:启用 */
    private static final int ACTIVE = 1;

    /** TTL=1 = 让 Cloudflare 自动选。橙云记录只认这个值 */
    private static final int TTL_AUTO = 1;

    /** 错误信息太长(连不上的异常里有整段 HTTP 细节)截一下再给前端 */
    private static final int MAX_MSG = 200;

    @Autowired
    private RestTemplate restTemplate;

    /**
     * token 的加密口令。用部署时随机生成的 jwt-secret(在 .env 里,升级/重启都不变):
     * 写死常量的话,这个公开仓库里的密钥等于没有;换成 jwt-secret,想解密得先拿到面板 .env。
     */
    @Value("${jwt-secret:eap-dns}")
    private String cryptoSecret;

    private volatile AESCrypto crypto;

    // ==================== 接口实现 ====================

    @Override
    public R listAccounts() {
        return guard(() -> {
            List<CfAccount> list = this.list(new QueryWrapper<CfAccount>().eq("status", ACTIVE).orderByAsc("id"));
            List<Map<String, Object>> out = new ArrayList<>();
            for (CfAccount a : list) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("id", a.getId());
                m.put("name", a.getName());
                m.put("status", a.getStatus());
                m.put("createdTime", a.getCreatedTime());
                m.put("updatedTime", a.getUpdatedTime());
                // 列表接口绝不返回明文,最多给个首尾字符的掩码,方便用户认出是哪一个 token
                m.put("tokenMask", maskToken(a));
                out.add(m);
            }
            return R.ok(out);
        });
    }

    @Override
    public R saveAccount(DnsAccountDto dnsAccountDto) {
        return guard(() -> {
            if (dnsAccountDto == null) {
                throw new DnsException("参数为空");
            }
            String name = trim(dnsAccountDto.getName());
            if (name.isEmpty()) {
                throw new DnsException("请给账号起个名字");
            }
            if (name.length() > 60) {
                throw new DnsException("账号名字最多 60 个字");
            }
            String token = trim(dnsAccountDto.getToken());
            CfAccount exists = dnsAccountDto.getId() == null ? null : this.getById(dnsAccountDto.getId());
            if (dnsAccountDto.getId() != null && exists == null) {
                throw new DnsException("账号不存在,刷新页面看看");
            }
            String plain;
            if (!token.isEmpty()) {
                plain = token;
            } else if (exists != null) {
                // 只改备注名:沿用原 token,不用用户再粘一遍
                plain = decrypt(exists.getTokenAes());
            } else {
                throw new DnsException("请填 Cloudflare API Token");
            }

            // 先验证 token 真能列域名再入库:存进去一个死 token,用户下次点开页面就是一片报错
            try {
                fetchZones(plain);
            } catch (DnsException e) {
                throw new DnsException("Token 无效:" + e.getMessage());
            }

            long now = System.currentTimeMillis();
            CfAccount save = exists != null ? exists : new CfAccount();
            save.setName(name);
            save.setTokenAes(encrypt(plain));
            save.setStatus(ACTIVE);
            save.setUpdatedTime(now);
            if (save.getCreatedTime() == null) {
                save.setCreatedTime(now);
            }
            boolean ok = exists != null ? this.updateById(save) : this.save(save);
            if (!ok) {
                throw new DnsException("保存失败");
            }

            Map<String, Object> data = new LinkedHashMap<>();
            data.put("id", save.getId());
            data.put("name", save.getName());
            data.put("tokenMask", maskToken(save));
            return ok(exists != null ? "账号已更新" : "账号已保存", data);
        });
    }

    @Override
    public R deleteAccount(Long id) {
        return guard(() -> {
            if (id == null) {
                throw new DnsException("请选择账号");
            }
            CfAccount acc = this.getById(id);
            if (acc == null) {
                throw new DnsException("账号不存在");
            }
            if (!this.removeById(id)) {
                throw new DnsException("删除失败");
            }
            return ok("已删除账号「" + acc.getName() + "」", null);
        });
    }

    @Override
    public R listZones(Long accountId) {
        return guard(() -> {
            CfAccount acc = requireAccount(accountId);
            List<JSONObject> zones = fetchZones(tokenOf(acc));
            List<Map<String, Object>> out = new ArrayList<>();
            for (JSONObject z : zones) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("id", z.getString("id"));
                m.put("name", z.getString("name"));
                m.put("status", z.getString("status"));
                m.put("type", z.getString("type"));
                out.add(m);
            }
            if (out.isEmpty()) {
                throw new DnsException("这个 token 下没有域名;确认 token 有该域名的 Zone.DNS 权限");
            }
            return R.ok(out);
        });
    }

    @Override
    public R listRecords(Long accountId, String zoneId) {
        return guard(() -> {
            CfAccount acc = requireAccount(accountId);
            String zone = trim(zoneId);
            if (zone.isEmpty()) {
                throw new DnsException("请先选域名");
            }
            return R.ok(recordsOf(tokenOf(acc), zone));
        });
    }

    @Override
    public R saveRecord(DnsRecordDto dnsRecordDto) {
        return guard(() -> {
            if (dnsRecordDto == null) {
                throw new DnsException("参数为空");
            }
            String zoneId = trim(dnsRecordDto.getZoneId());
            if (zoneId.isEmpty()) {
                throw new DnsException("请先选域名");
            }
            String type = trim(dnsRecordDto.getType()).toUpperCase();
            if (type.isEmpty()) {
                throw new DnsException("请选记录类型");
            }
            String content = trim(dnsRecordDto.getContent());
            if (content.isEmpty()) {
                throw new DnsException("请填记录内容");
            }
            CfAccount acc = requireAccount(dnsRecordDto.getAccountId());
            String token = tokenOf(acc);

            String name = trim(dnsRecordDto.getName());
            if (name.isEmpty() || "@".equals(name)) {
                // Cloudflare 的 API 不认 UI 上的 "@",根域必须写全称
                name = zoneName(token, zoneId);
            }

            JSONObject body = new JSONObject();
            body.put("type", type);
            body.put("name", name);
            body.put("content", content);
            Integer ttl = dnsRecordDto.getTtl();
            body.put("ttl", ttl == null || ttl <= 0 ? TTL_AUTO : ttl);
            // 只有 A/AAAA/CNAME 能开橙云;给 TXT 之类塞 proxied 会被 Cloudflare 直接拒
            if (proxyable(type)) {
                body.put("proxied", dnsRecordDto.getProxied() != null && dnsRecordDto.getProxied());
            }

            String recordId = trim(dnsRecordDto.getId());
            boolean create = recordId.isEmpty();
            String path = "/zones/" + zoneId + "/dns_records" + (create ? "" : "/" + recordId);
            JSONObject res = cfCall(token, create ? HttpMethod.POST : HttpMethod.PATCH, path, body);

            JSONObject result = res.getJSONObject("result");
            Map<String, Object> data = recordToMap(result, zoneId);
            return ok(create ? "记录已新增" : "记录已更新", data);
        });
    }

    @Override
    public R deleteRecord(Long accountId, String zoneId, String recordId) {
        return guard(() -> {
            CfAccount acc = requireAccount(accountId);
            String zone = trim(zoneId);
            String rid = trim(recordId);
            if (zone.isEmpty() || rid.isEmpty()) {
                throw new DnsException("记录ID或域名ID为空");
            }
            cfCall(tokenOf(acc), HttpMethod.DELETE, "/zones/" + zone + "/dns_records/" + rid, null);
            return ok("记录已删除", null);
        });
    }

    @Override
    public R pointRecord(DnsPointDto dnsPointDto) {
        return guard(() -> {
            if (dnsPointDto == null) {
                throw new DnsException("参数为空");
            }
            String domain = trim(dnsPointDto.getName()).toLowerCase();
            if (domain.isEmpty()) {
                throw new DnsException("请选或填要指向的域名");
            }
            String ip = trim(dnsPointDto.getIp());
            if (ip.isEmpty()) {
                throw new DnsException("拿不到这台机器的 IP,先在「转发机」里填好服务器 IP");
            }
            if (ip.contains(":")) {
                throw new DnsException("这台机器只填了 IPv6 地址;一键指向只改 A 记录,请把服务器 IP 填成 IPv4");
            }
            CfAccount acc = requireAccount(dnsPointDto.getAccountId());
            String token = tokenOf(acc);

            // 域名 → zone:一个账号下可能有多个域名,取后缀匹配最长(最具体的)那个
            JSONObject zone = bestZone(fetchZones(token), domain);
            if (zone == null) {
                throw new DnsException("这个账号里没有 " + domain + " 所属的域名;先去 Cloudflare 添加,或换个账号");
            }
            String zoneId = zone.getString("id");
            String zoneName = zone.getString("name");

            JSONObject found = null;
            for (JSONObject r : fetchRecords(token, zoneId)) {
                if (!"A".equalsIgnoreCase(r.getString("type"))) {
                    continue;
                }
                if (domain.equalsIgnoreCase(r.getString("name"))) {
                    found = r;
                    break;
                }
            }

            JSONObject body = new JSONObject();
            body.put("type", "A");
            body.put("name", domain);
            body.put("content", ip);
            body.put("ttl", TTL_AUTO);
            // 橙云一定要关:Cloudflare 反代只放行 80/443 等固定端口,节点端口它根本不转发,
            // 开着橙云"指向成功"了但客户端照样连不上 —— 那是比报错更难查的坑
            body.put("proxied", false);

            boolean create = found == null;
            String path = "/zones/" + zoneId + "/dns_records" + (create ? "" : "/" + found.getString("id"));
            cfCall(token, create ? HttpMethod.POST : HttpMethod.PATCH, path, body);

            Map<String, Object> data = new LinkedHashMap<>();
            data.put("action", create ? "create" : "update");
            data.put("name", domain);
            data.put("ip", ip);
            data.put("zoneName", zoneName);
            data.put("proxied", false);
            return ok((create ? "已新增 A 记录:" : "已改成:") + domain + " → " + ip, data);
        });
    }

    // ==================== Cloudflare 调用 ====================

    /** 发一次 Cloudflare 请求;success=false 时抛 errors[0].message */
    private JSONObject cfCall(String token, HttpMethod method, String path, JSONObject body) {
        HttpHeaders headers = new HttpHeaders();
        headers.set("Authorization", "Bearer " + token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        HttpEntity<Object> entity = new HttpEntity<>(body, headers);

        String raw;
        try {
            ResponseEntity<String> resp = restTemplate.exchange(API_BASE + path, method, entity, String.class);
            raw = resp.getBody();
        } catch (HttpStatusCodeException e) {
            // Cloudflare 的错(含 4xx)响应体里就是标准 JSON,把它的原话透传出去
            raw = e.getResponseBodyAsString();
            JSONObject parsed = parse(raw);
            String msg = parsed == null ? null : cfErrorMessage(parsed);
            throw new DnsException(msg != null ? msg : "Cloudflare 返回 HTTP " + e.getRawStatusCode());
        } catch (RestClientException e) {
            throw new DnsException("连不上 Cloudflare:" + shortMsg(e.getMessage()));
        }

        JSONObject parsed = parse(raw);
        if (parsed == null) {
            throw new DnsException("Cloudflare 返回内容无法解析");
        }
        if (!parsed.getBooleanValue("success")) {
            String msg = cfErrorMessage(parsed);
            throw new DnsException(msg != null ? msg : "Cloudflare 返回失败");
        }
        return parsed;
    }

    private List<JSONObject> fetchZones(String token) {
        JSONObject res = cfCall(token, HttpMethod.GET, "/zones?per_page=50", null);
        return toObjList(res.getJSONArray("result"));
    }

    private List<JSONObject> fetchRecords(String token, String zoneId) {
        JSONObject res = cfCall(token, HttpMethod.GET, "/zones/" + zoneId + "/dns_records?per_page=100", null);
        return toObjList(res.getJSONArray("result"));
    }

    private String zoneName(String token, String zoneId) {
        JSONObject res = cfCall(token, HttpMethod.GET, "/zones/" + zoneId, null);
        JSONObject result = res.getJSONObject("result");
        String name = result == null ? null : result.getString("name");
        if (name == null || name.trim().isEmpty()) {
            throw new DnsException("拿不到这个域名的信息,刷新页面重试");
        }
        return name.trim();
    }

    /** 记录列表 → 前端要的字段(不把 Cloudflare 原始结构整个吐出去) */
    private List<Map<String, Object>> recordsOf(String token, String zoneId) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (JSONObject r : fetchRecords(token, zoneId)) {
            out.add(recordToMap(r, zoneId));
        }
        return out;
    }

    private Map<String, Object> recordToMap(JSONObject r, String zoneId) {
        Map<String, Object> m = new LinkedHashMap<>();
        if (r == null) {
            return m;
        }
        m.put("id", r.getString("id"));
        m.put("zoneId", r.getString("zone_id") == null ? zoneId : r.getString("zone_id"));
        m.put("type", r.getString("type"));
        m.put("name", r.getString("name"));
        m.put("content", r.getString("content"));
        m.put("proxied", r.getBoolean("proxied"));
        m.put("ttl", r.getInteger("ttl"));
        return m;
    }

    /** errors[0].message,Cloudflare 的失败原因原话 */
    private String cfErrorMessage(JSONObject body) {
        String fromErrors = firstMessage(body.getJSONArray("errors"));
        if (fromErrors != null) {
            return fromErrors;
        }
        return firstMessage(body.getJSONArray("messages"));
    }

    private String firstMessage(JSONArray arr) {
        if (arr == null || arr.isEmpty()) {
            return null;
        }
        JSONObject first = arr.getJSONObject(0);
        if (first == null) {
            return null;
        }
        String msg = first.getString("message");
        if (msg == null || msg.trim().isEmpty()) {
            return null;
        }
        return msg.trim();
    }

    private JSONObject parse(String raw) {
        if (raw == null || raw.trim().isEmpty()) {
            return null;
        }
        try {
            return JSON.parseObject(raw);
        } catch (Exception e) {
            return null;
        }
    }

    private List<JSONObject> toObjList(JSONArray arr) {
        List<JSONObject> out = new ArrayList<>();
        if (arr == null) {
            return out;
        }
        for (int i = 0; i < arr.size(); i++) {
            JSONObject o = arr.getJSONObject(i);
            if (o != null) {
                out.add(o);
            }
        }
        return out;
    }

    /** 域名归属哪个 zone:同后缀取最长(api.example.com 优先于 example.com) */
    private JSONObject bestZone(List<JSONObject> zones, String domain) {
        JSONObject best = null;
        for (JSONObject z : zones) {
            String zn = trim(z.getString("name")).toLowerCase();
            if (zn.isEmpty()) {
                continue;
            }
            if (!domain.equals(zn) && !domain.endsWith("." + zn)) {
                continue;
            }
            if (best == null || zn.length() > trim(best.getString("name")).length()) {
                best = z;
            }
        }
        return best;
    }

    // ==================== 账号 / 加密 ====================

    private CfAccount requireAccount(Long accountId) {
        if (accountId == null) {
            throw new DnsException("请先选 Cloudflare 账号");
        }
        CfAccount acc = this.getById(accountId);
        if (acc == null) {
            throw new DnsException("Cloudflare 账号不存在,刷新页面看看");
        }
        return acc;
    }

    private String tokenOf(CfAccount acc) {
        return decrypt(acc.getTokenAes());
    }

    private AESCrypto aes() {
        AESCrypto c = crypto;
        if (c == null) {
            synchronized (this) {
                c = crypto;
                if (c == null) {
                    c = AESCrypto.create(cryptoSecret + "|eap-dns");
                    crypto = c;
                }
            }
        }
        return c;
    }

    private String encrypt(String plain) {
        AESCrypto c = aes();
        if (c == null) {
            throw new DnsException("服务端加密器初始化失败,检查面板的 JWT_SECRET 配置");
        }
        try {
            return c.encrypt(plain);
        } catch (Exception e) {
            throw new DnsException("Token 加密失败:" + shortMsg(e.getMessage()));
        }
    }

    private String decrypt(String cipherText) {
        AESCrypto c = aes();
        if (c == null) {
            throw new DnsException("服务端加密器初始化失败,检查面板的 JWT_SECRET 配置");
        }
        if (cipherText == null || cipherText.isEmpty()) {
            throw new DnsException("这个账号没存 token,请重新保存一次");
        }
        try {
            return c.decryptString(cipherText);
        } catch (Exception e) {
            throw new DnsException("Token 解密失败(面板加密密钥变过?),请在 DNS 页重新保存该账号");
        }
    }

    /** 掩码:只给首尾各 4 位,中间打星;解不开的密码就只给 **** */
    private String maskToken(CfAccount acc) {
        try {
            String plain = decrypt(acc.getTokenAes());
            if (plain.length() <= 12) {
                return "****";
            }
            return plain.substring(0, 4) + "****" + plain.substring(plain.length() - 4);
        } catch (Exception e) {
            return "****";
        }
    }

    private boolean proxyable(String type) {
        return "A".equals(type) || "AAAA".equals(type) || "CNAME".equals(type);
    }

    // ==================== 杂项 ====================

    /** 业务错误统一转成 R.err;意外异常也不能把 500 抛到前端 */
    private R guard(CfOp op) {
        try {
            return op.run();
        } catch (DnsException e) {
            return R.err(e.getMessage());
        } catch (Exception e) {
            log.warn("DNS 操作失败: {}", shortMsg(e.getMessage()));
            return R.err("操作失败:" + shortMsg(e.getMessage()));
        }
    }

    private R ok(String msg, Object data) {
        R r = R.ok(data);
        r.setMsg(msg);
        return r;
    }

    private String trim(String s) {
        return s == null ? "" : s.trim();
    }

    private String shortMsg(String s) {
        if (s == null) {
            return "未知错误";
        }
        String t = s.trim();
        return t.length() > MAX_MSG ? t.substring(0, MAX_MSG) : t;
    }

    private interface CfOp {
        R run();
    }

    /** 业务错误:消息直接给前端看 */
    private static class DnsException extends RuntimeException {
        DnsException(String msg) {
            super(msg);
        }
    }
}
