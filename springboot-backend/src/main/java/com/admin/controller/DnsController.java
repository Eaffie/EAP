package com.admin.controller;

import com.admin.common.annotation.RequireRole;
import com.admin.common.aop.LogAnnotation;
import com.admin.common.dto.DnsAccountDto;
import com.admin.common.dto.DnsPointDto;
import com.admin.common.dto.DnsRecordDto;
import com.admin.common.lang.R;
import com.admin.service.DnsService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/**
 * <p>
 * DNS 管理前端控制器(Cloudflare 域名解析)
 * </p>
 *
 * 面板直连 Cloudflare,不经过节点。所有接口仅管理员可用;返回里永远不带 token 明文。
 *
 * @since 2026-11-25
 */
@RestController
@RequestMapping("/api/v1/dns")
@CrossOrigin
public class DnsController extends BaseController {

    @Autowired
    private DnsService dnsService;

    /** 已保存的账号列表(带掩码,不含明文 token) */
    @LogAnnotation
    @RequireRole
    @PostMapping("/accounts")
    public R accounts() {
        return dnsService.listAccounts();
    }

    /** 新增/更新账号;保存前会先向 Cloudflare 验证 token */
    @LogAnnotation
    @RequireRole
    @PostMapping("/accounts/save")
    public R accountsSave(@RequestBody DnsAccountDto dnsAccountDto) {
        return dnsService.saveAccount(dnsAccountDto);
    }

    /** 删除账号 */
    @LogAnnotation
    @RequireRole
    @PostMapping("/accounts/delete")
    public R accountsDelete(@RequestBody Map<String, Object> params) {
        Long id = toLong(params.get("id"));
        if (id == null) {
            return R.err("请选择账号");
        }
        return dnsService.deleteAccount(id);
    }

    /** 该账号下的所有域名(zone) */
    @LogAnnotation
    @RequireRole
    @PostMapping("/zones")
    public R zones(@RequestBody Map<String, Object> params) {
        Long accountId = toLong(params.get("accountId"));
        if (accountId == null) {
            return R.err("请先选 Cloudflare 账号");
        }
        return dnsService.listZones(accountId);
    }

    /** 某个域名下的解析记录 */
    @LogAnnotation
    @RequireRole
    @PostMapping("/records")
    public R records(@RequestBody Map<String, Object> params) {
        Long accountId = toLong(params.get("accountId"));
        if (accountId == null) {
            return R.err("请先选 Cloudflare 账号");
        }
        Object zoneId = params.get("zoneId");
        return dnsService.listRecords(accountId, zoneId == null ? null : zoneId.toString());
    }

    /** 新增(id 为空)或修改(id 有值)一条解析记录 */
    @LogAnnotation
    @RequireRole
    @PostMapping("/record/save")
    public R recordSave(@RequestBody DnsRecordDto dnsRecordDto) {
        return dnsService.saveRecord(dnsRecordDto);
    }

    /** 删除一条解析记录 */
    @LogAnnotation
    @RequireRole
    @PostMapping("/record/delete")
    public R recordDelete(@RequestBody Map<String, Object> params) {
        Long accountId = toLong(params.get("accountId"));
        Object zoneId = params.get("zoneId");
        Object id = params.get("id");
        if (accountId == null || zoneId == null || id == null) {
            return R.err("参数不完整");
        }
        return dnsService.deleteRecord(accountId, zoneId.toString(), id.toString());
    }

    /** 一键指向:把某个域名的 A 记录指向目标 IP */
    @LogAnnotation
    @RequireRole
    @PostMapping("/record/point")
    public R recordPoint(@RequestBody DnsPointDto dnsPointDto) {
        return dnsService.pointRecord(dnsPointDto);
    }

    /** 前端传数字多数是 JSON number,但字符串也要认;解析不了就当没传 */
    private Long toLong(Object value) {
        if (value == null) {
            return null;
        }
        try {
            return Long.valueOf(value.toString().trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
