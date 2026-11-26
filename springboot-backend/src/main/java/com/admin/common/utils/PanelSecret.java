package com.admin.common.utils;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import javax.annotation.PostConstruct;
import javax.annotation.Resource;
import java.util.List;

/**
 * <p>
 * 面板密钥(jwt-secret)的唯一读取口
 * </p>
 *
 * jwt-secret 有两个用处:签/验登录 token(JwtUtil)和加解密 Cloudflare Token(DnsServiceImpl)。
 * 以前只用 .env 的 JWT_SECRET,换机器时那个值一变,DNS 账号就解不开、车主的登录态也全废。
 *
 * 现在改成【优先库里 vite_config.jwt_secret,其次 .env】:
 *   - 备份导出会把当前生效的值写进备份文件(见 BackupServiceImpl),恢复后它跟着数据库一起回来,
 *     DNS 账号立刻可用,不用去新机器上改 .env、也不用重启后端;
 *   - 老备份里没有这条记录,照旧用 .env,行为不变。
 *
 * 【安全】这条记录只在后端内部用:
 *   - 「网站配置」的读写接口全部过滤掉它(ViteConfigController / ViteConfigServiceImpl),不能给前端;
 *   - 备份文件里它是明文,所以导出时在文件头写了警告。
 *
 * 缓存 30 秒:JWT 校验每个请求都要读密钥,不缓存等于每个请求打一次库;这张表很小,
 * 30 秒的滞后只可能发生在「刚恢复完」这一瞬间,而恢复完成时会主动清缓存(clearCache)。
 *
 * @since 2026-11-26
 */
@Slf4j
@Component
public class PanelSecret {

    /** vite_config 里存面板密钥的键名 */
    public static final String KEY = "jwt_secret";

    /** 和 JwtUtil / DnsServiceImpl 原来的兜底值一致(正常部署走不到) */
    private static final String DEFAULT_SECRET = "eap-dns";

    /** 缓存时长:30 秒 */
    private static final long CACHE_MS = 30_000L;

    private static volatile PanelSecret INSTANCE;
    private static volatile String ENV_SECRET;
    private static volatile String CACHED;
    private static volatile long CACHED_AT;

    /** .env 里注入的 JWT_SECRET */
    @Value("${jwt-secret:eap-dns}")
    private String envSecret;

    @Resource
    private JdbcTemplate jdbc;

    @PostConstruct
    void init() {
        String s = envSecret == null ? "" : envSecret.trim();
        ENV_SECRET = s.isEmpty() ? DEFAULT_SECRET : s;
        INSTANCE = this;
    }

    /**
     * 当前生效的面板密钥:优先库里的(备份恢复带过来的),没有就用 .env 的 JWT_SECRET。
     * 永不返回 null。
     */
    public static String jwtSecret() {
        long now = System.currentTimeMillis();
        String cached = CACHED;
        if (cached != null && now - CACHED_AT < CACHE_MS) {
            return cached;
        }
        PanelSecret s = INSTANCE;
        if (s == null) {
            // Spring 还没装配好(理论上只可能发生在启动早期):不给缓存,直接用 .env
            return envSecret();
        }
        String fromDb = s.readFromDb();
        String value = fromDb != null && !fromDb.isEmpty() ? fromDb : envSecret();
        CACHED = value;
        CACHED_AT = now;
        return value;
    }

    /** .env 里的值(诊断 / 日志用,不要拿它去解密或验签) */
    public static String envSecret() {
        String e = ENV_SECRET;
        return e == null ? DEFAULT_SECRET : e;
    }

    /** 密钥是否来自数据库(不是 .env);只读,给日志用 */
    public static boolean fromDatabase() {
        PanelSecret s = INSTANCE;
        if (s == null) {
            return false;
        }
        String fromDb = s.readFromDb();
        return fromDb != null && !fromDb.isEmpty();
    }

    /** 恢复完 / 密钥被改之后调一次:下一次读就重新查库 */
    public static void clearCache() {
        CACHED = null;
        CACHED_AT = 0L;
    }

    /** 这个配置键是不是面板密钥 —— 「网站配置」的读写一律把它挡掉 */
    public static boolean isSecretKey(String name) {
        return name != null && KEY.equalsIgnoreCase(name.trim());
    }

    private String readFromDb() {
        try {
            List<String> rows = jdbc.queryForList(
                    "SELECT `value` FROM `vite_config` WHERE `name` = ? ORDER BY `id` LIMIT 1", String.class, KEY);
            if (rows == null || rows.isEmpty()) {
                return null;
            }
            String v = rows.get(0);
            return v == null ? null : v.trim();
        } catch (Exception e) {
            // 表还没建好 / 恢复中途表被 drop:退回 .env,不能因为读配置把登录和 DNS 全打死
            log.warn("读取 vite_config.{} 失败,本次改用 .env 的 JWT_SECRET: {}", KEY, e.getMessage());
            return null;
        }
    }
}
