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
        // 直连线路改成按【入站】算线路:每条直连入站一条 inbound_line / 一个订阅 token / 一份配额到期。
        // 中转(landing_id 非空)的 inbound_id 恒为空,行为不变。
        addColumnIfMissing("inbound_line", "inbound_id",
                "ALTER TABLE `inbound_line` ADD COLUMN `inbound_id` bigint(20) NULL COMMENT '直连线路所属入站;中转为空'");
        // 线路级限速同理:直连的规则要能按入站区分(老库里那批整机直连规则 inbound_id 为空,仍然生效)
        addColumnIfMissing("speed_limit", "inbound_id",
                "ALTER TABLE `speed_limit` ADD COLUMN `inbound_id` bigint(20) NULL COMMENT '线路级限速:直连所属入站'");

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

        // 列加完了才能搬数据
        splitLegacyDirectLines();
    }

    /**
     * 老库升级:把「整机一条直连线路」(landing_id 空、inbound_id 空)拆成「每条直连入站一条线路」。
     *
     * 为什么必须搬:老模型下一台机器的全部直连协议共用一条线路(共用订阅 token / 配额 / 到期 / 限速),
     * 新模型一条直连入站一条线路。不搬的话老库升级后这批线路一条都匹配不上(inbound_id 为空),
     * 车友手上的订阅链接当场失效、配额和到期也没人管。
     *
     * 三步(同一个连接、同一个事务,要么全成要么全不动):
     *   1. 老行留给自己名下【第一个】直连入站 —— 订阅 token 原样留着,车友手上那条链接照旧能用;
     *   2. 该机其余的直连入站各补一行(新 token),配额/到期/状态/建立时间照抄老行;
     *   3. inbound_user.sub_token 跟着自己那条线路走(此后同一台机器的直连各自一条订阅)。
     *
     * 幂等:只有还存在「匹配得到已分配入站、且 inbound_id 为空」的直连线路时才动手;
     * 搬完之后再启动就是空跑(纯僵尸行 —— 车友早就不分这台机器的直连了 —— 不参与,也就永远不动它)。
     * 出任何错只记日志:搬不动顶多是直连线路要车主重开一次,不能让面板起不来。
     */
    private void splitLegacyDirectLines() {
        Connection conn = null;
        try {
            conn = dataSource.getConnection();
            if (countPendingLegacyDirectLines(conn) == 0) {
                return;
            }
            boolean autoCommit = conn.getAutoCommit();
            conn.setAutoCommit(false);
            try {
                int kept = exec(conn, "UPDATE `inbound_line` l "
                        + "JOIN (SELECT iu.`user_id` AS uid, i.`node_id` AS nid, MIN(iu.`inbound_id`) AS first_inbound "
                        + "      FROM `inbound_user` iu JOIN `inbound` i ON i.`id` = iu.`inbound_id` "
                        + "      WHERE i.`landing_id` IS NULL GROUP BY iu.`user_id`, i.`node_id`) g "
                        + "  ON g.uid = l.`user_id` AND g.nid = l.`node_id` "
                        + "SET l.`inbound_id` = g.first_inbound, l.`updated_time` = UNIX_TIMESTAMP() * 1000 "
                        + "WHERE l.`landing_id` IS NULL AND l.`inbound_id` IS NULL");
                int added = exec(conn, "INSERT INTO `inbound_line` "
                        + "(`user_id`, `node_id`, `landing_id`, `inbound_id`, `sub_token`, `flow`, `exp_time`, `status`, `created_time`, `updated_time`) "
                        + "SELECT l.`user_id`, l.`node_id`, NULL, d.`iid`, REPLACE(UUID(), '-', ''), "
                        + "       l.`flow`, l.`exp_time`, l.`status`, l.`created_time`, l.`updated_time` "
                        + "FROM `inbound_line` l "
                        + "JOIN (SELECT DISTINCT iu.`user_id` AS uid, i.`node_id` AS nid, iu.`inbound_id` AS iid "
                        + "      FROM `inbound_user` iu JOIN `inbound` i ON i.`id` = iu.`inbound_id` "
                        + "      WHERE i.`landing_id` IS NULL) d "
                        + "  ON d.uid = l.`user_id` AND d.nid = l.`node_id` "
                        + "WHERE l.`landing_id` IS NULL AND l.`inbound_id` IS NOT NULL AND l.`inbound_id` <> d.`iid` "
                        + "  AND NOT EXISTS (SELECT 1 FROM (SELECT `user_id` AS u2, `node_id` AS n2, `inbound_id` AS i2 "
                        + "                                 FROM `inbound_line` WHERE `landing_id` IS NULL) x "
                        + "                  WHERE x.u2 = l.`user_id` AND x.n2 = l.`node_id` AND x.i2 = d.`iid`)");
                int filled = exec(conn, "UPDATE `inbound_line` SET `sub_token` = REPLACE(UUID(), '-', '') "
                        + "WHERE `landing_id` IS NULL AND `inbound_id` IS NOT NULL "
                        + "  AND (`sub_token` IS NULL OR `sub_token` = '')");
                int synced = exec(conn, "UPDATE `inbound_user` iu "
                        + "JOIN `inbound` i ON i.`id` = iu.`inbound_id` AND i.`landing_id` IS NULL "
                        + "JOIN `inbound_line` l ON l.`user_id` = iu.`user_id` AND l.`node_id` = i.`node_id` "
                        + "                      AND l.`landing_id` IS NULL AND l.`inbound_id` = iu.`inbound_id` "
                        + "SET iu.`sub_token` = l.`sub_token` "
                        + "WHERE l.`sub_token` IS NOT NULL AND l.`sub_token` <> '' AND (iu.`sub_token` IS NULL OR iu.`sub_token` <> l.`sub_token`)");
                conn.commit();
                log.info("直连线路已按入站拆分: 认领老行 {}、新开线路 {}、补 token {}、同步分配 token {}", kept, added, filled, synced);
            } catch (Exception e) {
                conn.rollback();
                throw e;
            } finally {
                conn.setAutoCommit(autoCommit);
            }
        } catch (Exception e) {
            log.warn("直连线路按入站拆分失败(旧线路保持原样,可手动重开): {}", e.getMessage());
        } finally {
            if (conn != null) {
                try {
                    conn.close();
                } catch (Exception ignore) {
                    // 关不掉也没办法
                }
            }
        }
    }

    /** 还有多少「老的整机直连线路」能被拆(有已分配的直连入站才算,免得纯僵尸行让迁移反复跑) */
    private long countPendingLegacyDirectLines(Connection conn) throws Exception {
        String sql = "SELECT COUNT(*) FROM `inbound_line` l "
                + "WHERE l.`landing_id` IS NULL AND l.`inbound_id` IS NULL "
                + "  AND EXISTS (SELECT 1 FROM `inbound_user` iu JOIN `inbound` i ON i.`id` = iu.`inbound_id` "
                + "              WHERE i.`landing_id` IS NULL AND i.`node_id` = l.`node_id` AND iu.`user_id` = l.`user_id`)";
        try (Statement st = conn.createStatement(); ResultSet rs = st.executeQuery(sql)) {
            return rs.next() ? rs.getLong(1) : 0L;
        }
    }

    private int exec(Connection conn, String sql) throws Exception {
        try (Statement st = conn.createStatement()) {
            return st.executeUpdate(sql);
        }
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
