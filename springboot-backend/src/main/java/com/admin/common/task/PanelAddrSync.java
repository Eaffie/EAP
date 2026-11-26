package com.admin.common.task;

import com.admin.common.dto.GostDto;
import com.admin.common.utils.WebSocketServer;
import com.alibaba.fastjson.JSONObject;
import lombok.extern.slf4j.Slf4j;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import javax.annotation.PostConstruct;
import javax.annotation.Resource;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * <p>
 * 面板地址下发(「节点连面板的地址跟着域名走」)
 * </p>
 *
 * 【为什么要做】节点 /etc/gost/config.json 里存的是面板 IP。面板一换域名,12 台节点还照着 IP 连,
 * 车主那边就会看到一批机器莫名其妙掉线 —— 得挨台改配置,还容易漏。
 *
 * 【规则一句话】面板有域名就用「域名:端口」,没有就用「IP:端口」,域名改了节点跟着改。
 * 地址的唯一来源是 vite_config:
 *   - name='ip'            :「网站配置」里那个面板后端地址,安装命令的 -a 也是它(eap domain 会把它改成 域名:端口)
 *   - name='panel_domain'  :eap domain 记下的面板域名(ip 还是 IP 时靠它兜底)
 * 后端容器读不到宿主机的 /etc/eap/Caddyfile,所以【不要】去读 Caddyfile。
 *
 * 【怎么下发】节点 WebSocket 连上之后,面板用 SetPanelAddr 命令把 panelAddr() 发给它;
 * 节点发现和自己 config.json 里的 addr 不一样才写文件 + 延迟几秒重启重连。
 * 只在地址和【上次下发给这个节点】的不同时才发 —— 否则每次重连都让节点重启一次。
 *
 * 版本门槛 1.2.7:1.2.6 及以前的节点不认识这条命令(会当成未知命令),不下发。
 * 也就是说【节点端要重装 / 升级到 1.2.7 之后这个功能才生效】。
 *
 * @since 2026-11-26
 */
@Slf4j
@Component
public class PanelAddrSync {

    /** vite_config 里存「面板后端地址」的键(和网站配置页 / 安装命令同一个) */
    public static final String KEY_IP = "ip";

    /** eap domain 记下的面板域名 */
    public static final String KEY_DOMAIN = "panel_domain";

    /** 默认后端端口(装机默认 6365;vite_config.ip 里有端口时以它为准) */
    static final int DEFAULT_PORT = 6365;

    /** 认识 SetPanelAddr 的最低节点端版本 */
    static final String MIN_AGENT_VERSION = "1.2.7";

    private static final String DOMAIN_RE =
            "^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$";

    private static PanelAddrSync INSTANCE;

    @Resource
    private JdbcTemplate jdbc;

    /** 下发要等节点响应(最多 10 秒),放单独线程,不卡 WebSocket 建连;几台一起重连也不会排队等半天 */
    private final ExecutorService pusher = Executors.newFixedThreadPool(4, new java.util.concurrent.ThreadFactory() {
        private final java.util.concurrent.atomic.AtomicInteger seq = new java.util.concurrent.atomic.AtomicInteger();

        @Override
        public Thread newThread(Runnable r) {
            Thread t = new Thread(r, "panel-addr-push-" + seq.incrementAndGet());
            t.setDaemon(true);
            return t;
        }
    });

    /** nodeId -> 上次成功下发的地址(只存内存:面板重启后重发一次,节点自己会比对,不会白重启) */
    private static final ConcurrentHashMap<Long, String> lastSent = new ConcurrentHashMap<>();

    @PostConstruct
    void init() {
        INSTANCE = this;
    }

    // ==================== 地址计算 ====================

    /** 节点该连的面板地址;实在没有配置就返回 null(调用方跳过下发) */
    public static String panelAddr() {
        PanelAddrSync s = INSTANCE;
        if (s == null) {
            return null;
        }
        return resolve(s.config(KEY_IP), s.config(KEY_DOMAIN));
    }

    /**
     * 纯计算(单测就是测它):
     *   1) vite_config.ip 已经是「域名:端口」→ 原样返回(端口跟着值走,装机改过端口的也不会错)
     *   2) ip 还是 IP 形式、但配了面板域名 → 「域名:端口」
     *   3) 都没有 → 「IP:端口」
     */
    static String resolve(String ipValue, String domainValue) {
        String ip = clean(ipValue);
        String domain = hostOnly(clean(domainValue));
        if (!ip.isEmpty()) {
            String host = hostOf(ip);
            int port = portOf(ip);
            if (isDomain(host)) {
                return join(host, port);
            }
            if (!domain.isEmpty()) {
                return join(domain, port);
            }
            return join(host, port);
        }
        if (!domain.isEmpty()) {
            return join(domain, DEFAULT_PORT);
        }
        return null;
    }

    /** IPv6 字面量要套方括号,否则 面板地址:端口 拼出来没法用 */
    private static String join(String host, int port) {
        return (host.contains(":") ? "[" + host + "]" : host) + ":" + port;
    }

    /** 去掉可能的 scheme / 首尾空白 / 末尾斜杠 */
    private static String clean(String raw) {
        String s = raw == null ? "" : raw.trim();
        if (s.regionMatches(true, 0, "http://", 0, 7)) {
            s = s.substring(7);
        } else if (s.regionMatches(true, 0, "https://", 0, 8)) {
            s = s.substring(8);
        }
        while (s.endsWith("/")) {
            s = s.substring(0, s.length() - 1);
        }
        return s.trim();
    }

    /** 取主机部分(兼容 [v6]:port 的写法) */
    private static String hostOf(String value) {
        String s = value;
        int path = s.indexOf('/');
        if (path >= 0) {
            s = s.substring(0, path);
        }
        if (s.startsWith("[")) {
            int end = s.indexOf(']');
            return end > 0 ? s.substring(1, end) : s;
        }
        int first = s.indexOf(':');
        int last = s.lastIndexOf(':');
        // 多个冒号 = 纯 IPv6 字面量(没有端口),整段都是主机
        if (first >= 0 && first != last) {
            return s;
        }
        return first < 0 ? s : s.substring(0, first);
    }

    /** 取端口,没写就用默认端口 */
    private static int portOf(String value) {
        String s = value;
        int path = s.indexOf('/');
        if (path >= 0) {
            s = s.substring(0, path);
        }
        int colon;
        if (s.startsWith("[")) {
            int end = s.indexOf(']');
            colon = end > 0 ? s.indexOf(':', end) : -1;
        } else {
            int first = s.indexOf(':');
            colon = first == s.lastIndexOf(':') ? first : -1;
        }
        if (colon < 0 || colon + 1 >= s.length()) {
            return DEFAULT_PORT;
        }
        try {
            int p = Integer.parseInt(s.substring(colon + 1).trim());
            return p > 0 && p <= 65535 ? p : DEFAULT_PORT;
        } catch (NumberFormatException e) {
            return DEFAULT_PORT;
        }
    }

    /** 只保留主机部分(域名配置项可能被写成 域名:端口) */
    private static String hostOnly(String value) {
        String host = hostOf(value);
        return isDomain(host) ? host : "";
    }

    /** 像域名的才算域名:纯数字(IPv4)、带冒号(IPv6)都不算 */
    static boolean isDomain(String host) {
        if (host == null || host.isEmpty()) {
            return false;
        }
        if (host.matches("^[0-9.]+$") || host.contains(":")) {
            return false;
        }
        return host.matches(DOMAIN_RE);
    }

    private String config(String name) {
        try {
            List<String> rows = jdbc.queryForList(
                    "SELECT `value` FROM `vite_config` WHERE `name` = ? ORDER BY `id` LIMIT 1", String.class, name);
            if (rows == null || rows.isEmpty()) {
                return null;
            }
            return rows.get(0);
        } catch (Exception e) {
            log.info("读 vite_config.{} 失败: {}", name, e.getMessage());
            return null;
        }
    }

    // ==================== 下发 ====================

    /** WebSocketServer 在节点连上来时调用;出任何问题都不能影响连接建立 */
    public static void onNodeConnected(Long nodeId, String version) {
        try {
            PanelAddrSync s = INSTANCE;
            if (s == null || nodeId == null) {
                return;
            }
            s.pusher.submit(() -> s.sync(nodeId, version));
        } catch (Exception e) {
            log.info("安排面板地址下发失败: {}", e.getMessage());
        }
    }

    /** 节点被删除:清掉它的记录 */
    public static void forgetNode(Long nodeId) {
        if (nodeId != null) {
            lastSent.remove(nodeId);
        }
    }

    void sync(Long nodeId, String version) {
        try {
            String addr = panelAddr();
            if (addr == null) {
                log.info("节点 {} 已连接,但面板地址没配(vite_config.{} 为空),不下发 SetPanelAddr", nodeId, KEY_IP);
                return;
            }
            if (!supports(version)) {
                log.info("节点 {} 面板地址应为 {},但节点端版本 {} 早于 {},暂不下发(升级节点端后自动生效)",
                        nodeId, addr, version, MIN_AGENT_VERSION);
                return;
            }
            if (addr.equals(lastSent.get(nodeId))) {
                return;
            }
            JSONObject cfg = new JSONObject();
            cfg.put("addr", addr);
            GostDto r = WebSocketServer.send_msg(nodeId, cfg, "SetPanelAddr");
            if (r != null && r.getCode() != null && r.getCode() == 1) {
                lastSent.put(nodeId, addr);
                log.info("节点 {} 面板地址下发成功({}):{}", nodeId, addr, r.getMsg());
            } else {
                log.info("节点 {} 面板地址下发未成功:{}", nodeId, r == null ? "无响应" : r.getMsg());
            }
        } catch (Exception e) {
            log.info("向节点 {} 下发面板地址失败: {}", nodeId, e.getMessage());
        }
    }

    /** 版本够了才下发(老节点把 SetPanelAddr 当未知命令) */
    static boolean supports(String version) {
        return version != null && compareVersion(version, MIN_AGENT_VERSION) >= 0;
    }

    /** 和 ProbeService 一个口径:按 . 分段比大小,非数字字符丢掉 */
    static int compareVersion(String a, String b) {
        String[] x = a.replaceAll("[^0-9.]", "").split("\\.");
        String[] y = b.replaceAll("[^0-9.]", "").split("\\.");
        for (int i = 0; i < Math.max(x.length, y.length); i++) {
            int p = i < x.length && !x[i].isEmpty() ? Integer.parseInt(x[i]) : 0;
            int q = i < y.length && !y[i].isEmpty() ? Integer.parseInt(y[i]) : 0;
            if (p != q) {
                return Integer.compare(p, q);
            }
        }
        return 0;
    }
}
