package com.admin.common.task;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 节点该连哪个面板地址:面板有域名用「域名:端口」,没有用「IP:端口」。
 * 地址唯一来源是 vite_config(ip / panel_domain),后端读不到宿主机的 Caddyfile,别去读它。
 */
class PanelAddrSyncTest {

    @Test
    void ipOnlyStaysIp() {
        assertEquals("107.149.151.133:6365", PanelAddrSync.resolve("107.149.151.133:6365", null));
        // 没写端口 → 默认端口
        assertEquals("107.149.151.133:6365", PanelAddrSync.resolve("107.149.151.133", null));
        assertEquals("107.149.151.133:6365", PanelAddrSync.resolve("  107.149.151.133  ", ""));
        // 装机时改过端口 → 跟着值走,不能写死 6365
        assertEquals("107.149.151.133:7000", PanelAddrSync.resolve("107.149.151.133:7000", null));
    }

    @Test
    void ipWithDomainConfiguredUsesDomain() {
        assertEquals("eapiiilllcv.hengyuukeji.com:6365",
                PanelAddrSync.resolve("107.149.151.133:6365", "eapiiilllcv.hengyuukeji.com"));
        // 端口跟 ip 里的走
        assertEquals("eapiiilllcv.hengyuukeji.com:7000",
                PanelAddrSync.resolve("107.149.151.133:7000", "eapiiilllcv.hengyuukeji.com"));
        // panel_domain 被写成 域名:端口 也认
        assertEquals("a.example.com:6365",
                PanelAddrSync.resolve("1.2.3.4:6365", "a.example.com:6365"));
    }

    @Test
    void domainValueIsUsedAsIs() {
        assertEquals("eapiiilllcv.hengyuukeji.com:6365",
                PanelAddrSync.resolve("eapiiilllcv.hengyuukeji.com:6365", null));
        // 已经是域名了,原样返回(端口也照原样,不再被默认端口覆盖)
        assertEquals("eapiiilllcv.hengyuukeji.com:1234",
                PanelAddrSync.resolve("eapiiilllcv.hengyuukeji.com:1234", "other.example.com"));
        // 带 http:// 和结尾斜杠也认得(安装命令里曾经出现过这种写法)
        assertEquals("eapiiilllcv.hengyuukeji.com:6365",
                PanelAddrSync.resolve("http://eapiiilllcv.hengyuukeji.com:6365/", null));
    }

    @Test
    void nothingConfigured() {
        assertNull(PanelAddrSync.resolve(null, null));
        assertNull(PanelAddrSync.resolve("", ""));
        // domain 那条不是域名(IP / 垃圾值)→ 不能拿来当地址
        assertNull(PanelAddrSync.resolve("", "1.2.3.4"));
        assertNull(PanelAddrSync.resolve(null, "not a domain"));
        // ip 空但域名在 → 用域名
        assertEquals("a.example.com:6365", PanelAddrSync.resolve(null, "a.example.com"));
    }

    @Test
    void ipv6GetsBrackets() {
        assertEquals("[2001:db8::1]:6365", PanelAddrSync.resolve("2001:db8::1", null));
        assertEquals("[2001:db8::1]:6365", PanelAddrSync.resolve("[2001:db8::1]:6365", null));
        assertEquals("a.example.com:6365", PanelAddrSync.resolve("[2001:db8::1]:6365", "a.example.com"));
    }

    @Test
    void onlyNewEnoughNodesGetTheCommand() {
        assertFalse(PanelAddrSync.supports(null));
        assertFalse(PanelAddrSync.supports("1.2.6"));
        assertFalse(PanelAddrSync.supports("1.1.9"));
        assertTrue(PanelAddrSync.supports("1.2.7"));
        assertTrue(PanelAddrSync.supports("1.2.10"));
        assertTrue(PanelAddrSync.supports("1.3.0"));
    }
}
