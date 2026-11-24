package com.admin.common.task;

import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

import javax.annotation.Resource;
import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.Statement;

/**
 * 启动时的表结构自动迁移。
 *
 * gost.sql 只在【新装】时执行一次,已经装好的面板 eap update 只换镜像、不动表结构。
 * 所以往实体里加字段必须配一次 ALTER,否则老用户一查就 Unknown column,面板直接崩。
 *
 * 这里做两种最安全的迁移:
 *  1. 「列不存在就加」:先查 information_schema 确认列缺失,再执行 ADD COLUMN;
 *  2. 「表不存在就建」:新功能如果带了新表(如 DNS 管理的 cf_account),老库升级后
 *     光靠 gost.sql 是不够的 —— 那个脚本只在【新装】时跑一次,所以这里补 CREATE TABLE IF NOT EXISTS。
 * 幂等、可重复执行,失败也只记日志不影响启动 ——
 * 迁移挂了顶多是新功能不可用,不能连带把整个面板拖死。
 */
@Slf4j
@Component
@Order(1)
public class SchemaMigration implements ApplicationRunner {

    @Resource
    private DataSource dataSource;

    @Override
    public void run(ApplicationArguments args) {
        // 转发机的「连接域名」:填了就用它生成节点链接,车友看到的是域名而不是车主的 IP
        // 线路级限速:一条中转(机器 × 落地)一个限速器,不按车友分。
        // node_id 为空 = 普通限速规则(限速管理页的那个),非空 = 线路级规则。
        addColumnIfMissing("speed_limit", "node_id",
                "ALTER TABLE `speed_limit` ADD COLUMN `node_id` bigint(20) NULL COMMENT '线路级限速:所属转发机,空=普通规则'");
        addColumnIfMissing("speed_limit", "landing_id",
                "ALTER TABLE `speed_limit` ADD COLUMN `landing_id` bigint(20) NULL COMMENT '线路级限速:所属落地'");

        addColumnIfMissing("node", "domain",
                "ALTER TABLE `node` ADD COLUMN `domain` VARCHAR(255) NULL COMMENT '连接域名(可选,留空用 server_ip)'");

        // 「全部线路」聚合订阅 token:一条链接包含该车友所有未停用线路的节点
        addColumnIfMissing("user", "all_sub_token",
                "ALTER TABLE `user` ADD COLUMN `all_sub_token` VARCHAR(64) NULL COMMENT '全部线路聚合订阅token'");

        // 分给车友的转发要能进订阅,面板就得持有一条可直接导入客户端的链接。
        // 落地的账号密码本来只存在车主本机(gost 只搬字节,凭据不上传)——
        // 这是三月明确权衡后选的:用"凭据落在面板 DB"换"车友一条 URL、增删自动同步"。
        // 只存分配给车友的那些;车主自己的转发不写这一列。
        addColumnIfMissing("forward", "client_link",
                "ALTER TABLE `forward` ADD COLUMN `client_link` VARCHAR(1024) NULL COMMENT '给车友的客户端链接(进聚合订阅用)'");

        // IPv6:服务器 v6 地址 / 订阅出 v6 节点 / 双栈
        addColumnIfMissing("node", "server_ipv6",
                "ALTER TABLE `node` ADD COLUMN `server_ipv6` VARCHAR(64) NULL COMMENT '服务器IPv6地址(可选)'");
        addColumnIfMissing("node", "ipv6_sub",
                "ALTER TABLE `node` ADD COLUMN `ipv6_sub` TINYINT NOT NULL DEFAULT 0 COMMENT '订阅出IPv6节点'");
        addColumnIfMissing("node", "ipv6_dual",
                "ALTER TABLE `node` ADD COLUMN `ipv6_dual` TINYINT NOT NULL DEFAULT 0 COMMENT 'IPv6双栈'");

        // DNS 管理(直连 Cloudflare 改解析记录)。
        // token 只存 AES-GCM 密文:面板是公网可访问的,一个能改 DNS 的 token 丢了就能劫持域名解析。
        createTableIfMissing("cf_account",
                "CREATE TABLE IF NOT EXISTS `cf_account` (" +
                        "`id` bigint(20) NOT NULL AUTO_INCREMENT," +
                        "`name` varchar(64) NOT NULL COMMENT '账号备注名'," +
                        "`token_aes` TEXT NULL COMMENT 'Cloudflare API Token(AES-GCM 密文)'," +
                        "`status` tinyint(4) NOT NULL DEFAULT 1 COMMENT '状态(1:启用)'," +
                        "`created_time` bigint(20) NULL COMMENT '创建时间(毫秒时间戳)'," +
                        "`updated_time` bigint(20) NULL COMMENT '更新时间(毫秒时间戳)'," +
                        "PRIMARY KEY (`id`)" +
                        ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;");
    }

    /**
     * 表不存在才建。给新功能加表用:老库升级不会重跑 gost.sql,少了这一步新功能直接查空表报错。
     * ddl 里仍然写 IF NOT EXISTS,并发启动/手工执行时都安全。
     */
    private void createTableIfMissing(String table, String ddl) {
        try (Connection conn = dataSource.getConnection()) {
            if (tableExists(conn, table)) {
                return;
            }
            try (Statement st = conn.createStatement()) {
                st.executeUpdate(ddl);
                log.info("表结构迁移: 表 {} 已创建", table);
            }
        } catch (Exception e) {
            // 并发启动时另一个实例可能刚好建完(1050 Table already exists),这属于正常情况
            String msg = e.getMessage() == null ? "" : e.getMessage();
            if (msg.contains("already exists") || msg.contains("1050")) {
                log.debug("表结构迁移: 表 {} 已存在,跳过", table);
            } else {
                log.warn("建表失败 {}: {}", table, msg);
            }
        }
    }

    private boolean tableExists(Connection conn, String table) throws Exception {
        DatabaseMetaData meta = conn.getMetaData();
        try (ResultSet rs = meta.getTables(conn.getCatalog(), null, table, new String[]{"TABLE"})) {
            if (rs.next()) {
                return true;
            }
        }
        // 大小写/驱动差异兜底(cf_account 这种小写名在部分环境下 matching 不到)
        try (Statement st = conn.createStatement();
             ResultSet rs = st.executeQuery("SHOW TABLES LIKE '" + table + "'")) {
            return rs.next();
        }
    }

    /** 列不存在才执行 ddl;任何异常都吞掉(只记日志),不能因为迁移失败导致面板起不来 */
    private void addColumnIfMissing(String table, String column, String ddl) {
        try (Connection conn = dataSource.getConnection()) {
            if (columnExists(conn, table, column)) {
                return;
            }
            try (Statement st = conn.createStatement()) {
                st.executeUpdate(ddl);
                log.info("表结构迁移: {}.{} 已添加", table, column);
            }
        } catch (Exception e) {
            // 并发启动时另一个实例可能刚好加完(1060 Duplicate column),这属于正常情况
            String msg = e.getMessage() == null ? "" : e.getMessage();
            if (msg.contains("Duplicate column") || msg.contains("1060")) {
                log.debug("表结构迁移: {}.{} 已存在,跳过", table, column);
            } else {
                log.warn("表结构迁移失败 {}.{}: {}", table, column, msg);
            }
        }
    }

    private boolean columnExists(Connection conn, String table, String column) throws Exception {
        DatabaseMetaData meta = conn.getMetaData();
        try (ResultSet rs = meta.getColumns(conn.getCatalog(), null, table, column)) {
            return rs.next();
        }
    }
}
