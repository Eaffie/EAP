package com.admin.service.impl;

import com.admin.common.lang.R;
import com.admin.service.BackupService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import javax.servlet.http.HttpServletResponse;
import javax.sql.DataSource;
import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Types;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.locks.ReentrantLock;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * <p>
 * 数据库备份 / 恢复实现(纯 JDBC,不依赖 mysqldump)
 * </p>
 *
 * 为什么不用 mysqldump:后端镜像 eclipse-temurin:21-jre-noble 里没有 mysql 客户端,
 * 装一个等于给镜像加包、还要改 Dockerfile / compose —— 这两样都在本次改动范围之外。
 *
 * 导出格式照 mysqldump 的样式写(便于人工打开检查),末尾也写 "-- Dump completed on ...",
 * 这样 panel_install.sh 里 eap restore 的完整性强校验能直接认这份文件。
 *
 * 导入的重点是【稳】:
 *   - 按分号切语句时要认单/双引号、反引号、-- 、# /* *&#47; 注释和反斜杠转义,不能把字符串里的分号当分隔符;
 *   - 兼容 mysqldump 产物:LOCK TABLES / UNLOCK TABLES / SET xxx / USE / CREATE DATABASE 一律跳过,
 *     /*!40101 ... *&#47; 这类条件注释整段当注释丢掉;
 *   - 含 DELIMITER 就明确报错 —— 那种文件里有存储过程/触发器,拿分号硬切只会切坏数据;
 *   - 执行前自动做一份 before_restore_*.sql(失败则中止);
 *   - 成功后把 node.status 全部清 0(备份里节点全是"在线",新面板没有那些连接会一直假在线)。
 *
 * @since 2026-11-26
 */
@Slf4j
@Service
public class BackupServiceImpl implements BackupService {

    /** 备份目录:后端容器里 /app/logs 是已有的 backend_logs 卷,别新增卷 */
    private static final String DIR_NAME = "backups";

    /** 文件名白名单:只允许这些字符 + .sql 结尾,防目录穿越 */
    private static final String NAME_PATTERN = "[A-Za-z0-9_.-]+\\.sql";

    /** 只留最近 20 个文件,防止容器磁盘被备份堆满 */
    private static final int KEEP_FILES = 20;

    /** 上传上限(spring.servlet.multipart.max-file-size 也是 50MB) */
    private static final long MAX_UPLOAD = 50L * 1024 * 1024;

    /** 每条 INSERT 拼多少行 */
    private static final int BATCH_ROWS = 500;

    /** 监控历史表:默认不进备份(2.2 万 + 1.4 万行,占了全库 4MB 的绝大部分) */
    private static final List<String> MONITOR_TABLES = List.of("monitor_metric", "monitor_probe");

    /** 备份文件名里的时间戳 */
    private static final DateTimeFormatter NAME_TS = DateTimeFormatter.ofPattern("yyyyMMdd_HHmmss");

    /** 文件头里的可读时间 */
    private static final DateTimeFormatter READ_TS = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");

    /** 错误信息太长就截断,别把整段堆栈塞给前端 */
    private static final int MAX_MSG = 300;

    @Autowired
    private DataSource dataSource;

    /** 和后端日志同一个卷(compose 里 LOG_DIR=/app/logs) */
    @Value("${log-dir:/app/logs}")
    private String logDir;

    /** 导出/导入串行,避免两个 dump 同时跑 */
    private final ReentrantLock lock = new ReentrantLock();

    // ==================== 列表 ====================

    @Override
    public R list() {
        try {
            List<Map<String, Object>> out = new ArrayList<>();
            for (Path f : listSqlFiles(dir())) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("name", f.getFileName().toString());
                m.put("size", Files.size(f));
                m.put("createdTime", Files.getLastModifiedTime(f).toMillis());
                out.add(m);
            }
            return R.ok(out);
        } catch (Exception e) {
            log.warn("列出备份文件失败: {}", shortMsg(e.getMessage()));
            return R.err("列出备份文件失败:" + shortMsg(e.getMessage()));
        }
    }

    // ==================== 导出 ====================

    @Override
    public R export(boolean includeMonitor) {
        if (!lock.tryLock()) {
            return R.err("正在执行另一个备份/恢复任务,请稍后再试");
        }
        try {
            String name = "eap_backup_" + LocalDateTime.now().format(NAME_TS) + (includeMonitor ? "_full" : "") + ".sql";
            long start = System.currentTimeMillis();
            Dump dump = writeDump(name, includeMonitor);
            long size = Files.size(dump.path);
            int removed = cleanupOldFiles();

            Map<String, Object> data = new LinkedHashMap<>();
            data.put("fileName", name);
            data.put("size", size);
            data.put("includeMonitor", includeMonitor);
            data.put("tables", dump.tables);
            data.put("rows", dump.rows);
            data.put("elapsedMs", System.currentTimeMillis() - start);
            data.put("removedOld", removed);
            return ok("备份完成:" + name + "(" + readableSize(size) + (removed > 0 ? ",已清理 " + removed + " 个旧备份" : "") + ")", data);
        } catch (Exception e) {
            log.warn("导出备份失败: {}", shortMsg(e.getMessage()));
            return R.err("导出备份失败:" + shortMsg(e.getMessage()));
        } finally {
            lock.unlock();
        }
    }

    /** 真正的 dump:先 SHOW CREATE TABLE 再 SELECT *,写成 mysqldump 风格的 .sql */
    private Dump writeDump(String fileName, boolean includeMonitor) throws Exception {
        Path dir = dir();
        Files.createDirectories(dir);
        Path target = dir.resolve(fileName);
        Dump out = new Dump();
        out.path = target;
        boolean finished = false;
        try (BufferedWriter w = Files.newBufferedWriter(target, StandardCharsets.UTF_8)) {
            try (Connection conn = dataSource.getConnection()) {
                conn.setAutoCommit(true);
                try (Statement st = conn.createStatement()) {
                    try {
                        st.execute("SET NAMES utf8mb4");
                    } catch (SQLException ignore) {
                        // 连不上就算了,连接本身已经是 utf8mb4
                    }

                    w.write("-- EAP 数据库备份\n");
                    w.write("-- 生成时间: " + LocalDateTime.now().format(READ_TS) + "\n");
                    w.write("-- 包含监控历史: " + (includeMonitor ? "是" : "否") + "\n");
                    w.write("-- 来源: 面板「网站配置 → 备份与恢复」。可用同一页面上传恢复,也可在服务器上 eap restore。\n\n");
                    w.write("SET NAMES utf8mb4;\n");
                    w.write("SET FOREIGN_KEY_CHECKS=0;\n\n");
                    if (!includeMonitor) {
                        w.write("-- 已跳过监控历史表(" + String.join(", ", MONITOR_TABLES)
                                + "):换机器不需要它们,勾选「包含监控历史」可以带上\n\n");
                    }

                    for (String table : listTables(st, includeMonitor)) {
                        out.tables++;
                        w.write("-- ----------------------------\n");
                        w.write("-- 表: " + table + "\n");
                        w.write("-- ----------------------------\n");
                        w.write("DROP TABLE IF EXISTS `" + table + "`;\n");
                        w.write(createTableSql(st, table) + ";\n\n");
                        out.rows += writeTableData(w, st, table);
                    }

                    w.write("SET FOREIGN_KEY_CHECKS=1;\n\n");
                    // panel_install.sh 的 _verify_sql_dump 认这一行,别删
                    w.write("-- Dump completed on " + LocalDateTime.now().format(READ_TS) + "\n");
                }
            }
            finished = true;
        } finally {
            if (!finished) {
                Files.deleteIfExists(target);
            }
        }
        return out;
    }

    private List<String> listTables(Statement st, boolean includeMonitor) throws SQLException {
        List<String> names = new ArrayList<>();
        try (ResultSet rs = st.executeQuery("SHOW FULL TABLES WHERE Table_type='BASE TABLE'")) {
            while (rs.next()) {
                String name = rs.getString(1);
                if (name == null || name.trim().isEmpty()) {
                    continue;
                }
                if (!includeMonitor && MONITOR_TABLES.contains(name)) {
                    continue;
                }
                names.add(name);
            }
        }
        names.sort(String::compareTo);
        return names;
    }

    private String createTableSql(Statement st, String table) throws SQLException {
        try (ResultSet rs = st.executeQuery("SHOW CREATE TABLE `" + table + "`")) {
            if (!rs.next()) {
                throw new SQLException("拿不到表结构:" + table);
            }
            // 第 2 列是 CREATE TABLE 语句;第 1 列是表名
            String sql = rs.getString(2);
            if (sql == null) {
                throw new SQLException("拿不到表结构:" + table);
            }
            sql = sql.trim();
            if (sql.endsWith(";")) {
                sql = sql.substring(0, sql.length() - 1);
            }
            return sql;
        }
    }

    /** 全表数据 → 每 BATCH_ROWS 行一条 INSERT */
    private long writeTableData(BufferedWriter w, Statement st, String table) throws Exception {
        long rows = 0;
        try (ResultSet rs = st.executeQuery("SELECT * FROM `" + table + "`")) {
            ResultSetMetaData md = rs.getMetaData();
            int cols = md.getColumnCount();
            String[] names = new String[cols];
            int[] types = new int[cols];
            StringBuilder colList = new StringBuilder();
            for (int i = 0; i < cols; i++) {
                names[i] = md.getColumnName(i + 1);
                types[i] = md.getColumnType(i + 1);
                if (i > 0) {
                    colList.append(", ");
                }
                colList.append('`').append(names[i]).append('`');
            }
            String prefix = "INSERT INTO `" + table + "` (" + colList + ") VALUES\n";

            StringBuilder batch = new StringBuilder();
            int count = 0;
            while (rs.next()) {
                rows++;
                if (count == 0) {
                    batch.append(prefix);
                } else {
                    batch.append(",\n");
                }
                batch.append('(');
                for (int i = 0; i < cols; i++) {
                    if (i > 0) {
                        batch.append(',');
                    }
                    appendValue(batch, rs, i + 1, types[i]);
                }
                batch.append(')');
                count++;
                if (count >= BATCH_ROWS) {
                    batch.append(";\n");
                    w.write(batch.toString());
                    batch.setLength(0);
                    count = 0;
                }
            }
            if (count > 0) {
                batch.append(";\n");
                w.write(batch.toString());
            }
            if (rows == 0) {
                w.write("-- 表 " + table + " 没有数据\n");
            }
            w.write("\n");
        }
        return rows;
    }

    /**
     * 一个字段值 → SQL 字面量。
     * 数字原样(NULL 输出 NULL),其余一律按字符串处理并转义;
     * 二进制列(现在库里没有,以后加了也不会被转坏)输出 0x 十六进制。
     */
    private void appendValue(StringBuilder sb, ResultSet rs, int idx, int type) throws SQLException {
        switch (type) {
            case Types.TINYINT:
            case Types.SMALLINT:
            case Types.INTEGER:
            case Types.BIGINT:
            case Types.FLOAT:
            case Types.REAL:
            case Types.DOUBLE:
            case Types.NUMERIC:
            case Types.DECIMAL:
                String num = rs.getString(idx);
                sb.append(rs.wasNull() || num == null ? "NULL" : num);
                return;
            case Types.BIT:
            case Types.BOOLEAN:
                boolean b = rs.getBoolean(idx);
                sb.append(rs.wasNull() ? "NULL" : (b ? "1" : "0"));
                return;
            case Types.BINARY:
            case Types.VARBINARY:
            case Types.LONGVARBINARY:
                byte[] bytes = rs.getBytes(idx);
                if (bytes == null || rs.wasNull()) {
                    sb.append("NULL");
                } else {
                    sb.append("0x");
                    for (byte v : bytes) {
                        sb.append(Character.forDigit((v >> 4) & 0xF, 16));
                        sb.append(Character.forDigit(v & 0xF, 16));
                    }
                }
                return;
            default:
                String s = rs.getString(idx);
                if (s == null || rs.wasNull()) {
                    sb.append("NULL");
                } else {
                    appendQuoted(sb, s);
                }
        }
    }

    /** 字符串转义:\\ ' \n \r \0 \x1a。写注释里的 HTML 实体只是为了不在源码里出现真正的注释结束符 */
    private void appendQuoted(StringBuilder sb, String s) {
        sb.append('\'');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '\0':
                    sb.append("\\0");
                    break;
                case '\n':
                    sb.append("\\n");
                    break;
                case '\r':
                    sb.append("\\r");
                    break;
                case '\\':
                    sb.append("\\\\");
                    break;
                case '\'':
                    sb.append("\\'");
                    break;
                case '\032':
                    sb.append("\\Z");
                    break;
                default:
                    sb.append(c);
            }
        }
        sb.append('\'');
    }

    // ==================== 下载 ====================

    @Override
    public void download(String name, HttpServletResponse response) {
        try {
            Path dir = dir();
            Path file = resolveSafe(dir, name);
            if (file == null) {
                writeJsonError(response, "文件名不合法");
                return;
            }
            if (!Files.isRegularFile(file)) {
                writeJsonError(response, "备份文件不存在:" + name);
                return;
            }
            byte[] data = Files.readAllBytes(file);
            response.setContentType("application/sql; charset=utf-8");
            response.setHeader("Content-Disposition", "attachment; filename=\"" + name + "\"");
            response.setContentLengthLong(data.length);
            response.getOutputStream().write(data);
            response.flushBuffer();
        } catch (Exception e) {
            log.warn("下载备份失败: {}", shortMsg(e.getMessage()));
            writeJsonError(response, "下载备份失败:" + shortMsg(e.getMessage()));
        }
    }

    // ==================== 恢复 ====================

    @Override
    public R restore(MultipartFile file, Boolean skipSafetyBackup) {
        if (file == null || file.isEmpty()) {
            return R.err("请选择要恢复的 .sql 文件");
        }
        String original = file.getOriginalFilename();
        if (original == null || !original.toLowerCase(Locale.ROOT).endsWith(".sql")) {
            return R.err("只支持 .sql 备份文件");
        }
        if (file.getSize() > MAX_UPLOAD) {
            return R.err("文件超过 50MB 上限");
        }

        if (!lock.tryLock()) {
            return R.err("正在执行另一个备份/恢复任务,请稍后再试");
        }
        try {
            String text;
            try {
                text = new String(file.getBytes(), StandardCharsets.UTF_8);
            } catch (IOException e) {
                return R.err("读取上传文件失败:" + shortMsg(e.getMessage()));
            }
            if (text.startsWith("\uFEFF")) {
                text = text.substring(1);
            }
            if (text.trim().isEmpty()) {
                return R.err("备份文件是空的");
            }

            List<String> statements;
            try {
                statements = splitStatements(text);
            } catch (BackupException e) {
                return R.err(e.getMessage());
            }
            if (statements.isEmpty()) {
                return R.err("备份文件里没有可执行的 SQL");
            }

            // 恢复前先存一份现状:传错文件时还能退回去
            String safety = null;
            if (!Boolean.TRUE.equals(skipSafetyBackup)) {
                String safetyName = "before_restore_" + LocalDateTime.now().format(NAME_TS) + ".sql";
                try {
                    Dump d = writeDump(safetyName, true);
                    safety = safetyName;
                    log.info("恢复前备份: {} ({} 表 {} 行)", safetyName, d.tables, d.rows);
                } catch (Exception e) {
                    log.warn("恢复前备份失败: {}", shortMsg(e.getMessage()));
                    return R.err("恢复前备份失败,已中止恢复:" + shortMsg(e.getMessage()));
                }
            }

            long start = System.currentTimeMillis();
            int executed = 0;
            int skipped = 0;
            try (Connection conn = dataSource.getConnection()) {
                conn.setAutoCommit(true);
                try (Statement st = conn.createStatement()) {
                    try {
                        st.execute("SET FOREIGN_KEY_CHECKS=0");
                    } catch (SQLException ignore) {
                        // 老版本 MySQL 没这个开关也能继续
                    }
                    try {
                        for (String sql : statements) {
                            if (shouldSkip(sql)) {
                                skipped++;
                                continue;
                            }
                            try {
                                st.execute(sql);
                                executed++;
                            } catch (SQLException e) {
                                throw new BackupException("第 " + (executed + skipped + 1) + " 条语句执行失败:"
                                        + shortMsg(e.getMessage()) + "\n语句开头:" + snippet(sql));
                            }
                        }
                    } finally {
                        try {
                            st.execute("SET FOREIGN_KEY_CHECKS=1");
                        } catch (SQLException ignore) {
                            // 连接马上就要还回池里,恢复失败时这个开关无所谓
                        }
                    }

                    // 备份里节点全是"在线"(旧面板连接正常时导的),新面板没有那些连接 → 会一直假在线。
                    // node.status 只有 WebSocket 连上/断开时才改,这里先全部置 0;
                    // 然后按当前真正握着连接的那几台改回 1(它们是实打实在线的,面板不该报离线)。
                    int nodeReset;
                    try {
                        nodeReset = st.executeUpdate("UPDATE node SET status=0");
                        java.util.Set<Long> online = com.admin.common.utils.WebSocketServer.connectedNodeIds();
                        if (!online.isEmpty()) {
                            StringBuilder sb = new StringBuilder("UPDATE node SET status=1 WHERE id IN (");
                            int i = 0;
                            for (Long id : online) {
                                if (i++ > 0) {
                                    sb.append(',');
                                }
                                sb.append(id);
                            }
                            sb.append(')');
                            int back = st.executeUpdate(sb.toString());
                            nodeReset = Math.max(0, nodeReset - back);
                        }
                    } catch (SQLException e) {
                        nodeReset = -1;
                        log.warn("重置节点在线状态失败: {}", shortMsg(e.getMessage()));
                    }

                    Map<String, Object> data = new LinkedHashMap<>();
                    data.put("executed", executed);
                    data.put("skipped", skipped);
                    data.put("safetyBackup", safety);
                    data.put("nodeReset", nodeReset);
                    data.put("elapsedMs", System.currentTimeMillis() - start);
                    return ok("恢复完成:执行 " + executed + " 条语句,跳过 " + skipped + " 条"
                            + (safety != null ? ";恢复前的数据已存为 " + safety : ""), data);
                }
            } catch (BackupException e) {
                log.warn("恢复失败: {}", e.getMessage());
                return R.err(e.getMessage() + (safety != null ? "\n当前库可能停在中间状态,可用 " + safety + " 退回" : ""));
            }
        } catch (Exception e) {
            log.warn("恢复失败: {}", shortMsg(e.getMessage()));
            return R.err("恢复失败:" + shortMsg(e.getMessage()));
        } finally {
            lock.unlock();
        }
    }

    /**
     * 按分号切 SQL 语句(跳过注释和引号里的分号)。
     *
     * 注释整段丢掉(含 /*!40101 ... *&#47; 这类条件注释),所以最终语句里不会夹注释;
     * 反引号里的内容按标识符处理(不认反斜杠转义,只认双写反引号)。
     */
    private List<String> splitStatements(String sql) {
        List<String> out = new ArrayList<>();
        StringBuilder buf = new StringBuilder();
        boolean hasContent = false;
        int n = sql.length();
        int i = 0;
        while (i < n) {
            char c = sql.charAt(i);

            // -- 行注释(MySQL 要求 -- 后面跟空白;文件末尾的 -- 也当注释)
            if (c == '-' && i + 1 < n && sql.charAt(i + 1) == '-'
                    && (i + 2 >= n || Character.isWhitespace(sql.charAt(i + 2)))) {
                while (i < n && sql.charAt(i) != '\n') {
                    i++;
                }
                continue;
            }
            // # 行注释
            if (c == '#') {
                while (i < n && sql.charAt(i) != '\n') {
                    i++;
                }
                continue;
            }
            // /* */ 块注释(含 /*! ... */ 条件注释):整段丢掉
            if (c == '/' && i + 1 < n && sql.charAt(i + 1) == '*') {
                int end = sql.indexOf("*/", i + 2);
                if (end < 0) {
                    throw new BackupException("备份文件里有没闭合的 /* 注释,文件可能不完整(导出被中途打断?)");
                }
                i = end + 2;
                continue;
            }
            // 引号 / 反引号:整段照抄,里面的分号不算分隔符
            if (c == '\'' || c == '"' || c == '`') {
                int end = skipQuoted(sql, i, c);
                buf.append(sql, i, end);
                hasContent = true;
                i = end;
                continue;
            }
            if (c == ';') {
                addStatement(out, buf);
                buf.setLength(0);
                hasContent = false;
                i++;
                continue;
            }
            // DELIMITER:这种文件里有存储过程/触发器,拿分号硬切一定会切坏,直接报错
            if (!hasContent && Character.isLetter(c)) {
                int j = i;
                while (j < n && (Character.isLetterOrDigit(sql.charAt(j)) || sql.charAt(j) == '_')) {
                    j++;
                }
                if ("DELIMITER".equalsIgnoreCase(sql.substring(i, j))) {
                    throw new BackupException("不支持含 DELIMITER 的备份文件(通常来自存储过程/触发器/视图);"
                            + "请改用不含 DELIMITER 的 .sql,或在服务器上执行 eap restore");
                }
                buf.append(sql, i, j);
                hasContent = true;
                i = j;
                continue;
            }
            buf.append(c);
            if (!Character.isWhitespace(c)) {
                hasContent = true;
            }
            i++;
        }
        addStatement(out, buf);
        return out;
    }

    /** 跳过一段引号内容,返回闭合引号之后的下标 */
    private int skipQuoted(String sql, int start, char quote) {
        int n = sql.length();
        int i = start + 1;
        while (i < n) {
            char c = sql.charAt(i);
            if (c == '\\' && quote != '`') {
                // 反斜杠转义(字符串里 \" \' \\ 都靠它)
                i += 2;
                continue;
            }
            if (c == quote) {
                if (i + 1 < n && sql.charAt(i + 1) == quote) {
                    // 双写引号 = 一个引号字符
                    i += 2;
                    continue;
                }
                return i + 1;
            }
            i++;
        }
        throw new BackupException("备份文件里有没闭合的引号,文件可能不完整(导出被中途打断?)");
    }

    private void addStatement(List<String> out, StringBuilder buf) {
        String s = buf.toString().trim();
        if (s.isEmpty()) {
            return;
        }
        // 去掉尾部多余的分号/空白再收
        while (s.endsWith(";")) {
            s = s.substring(0, s.length() - 1).trim();
        }
        if (!s.isEmpty()) {
            out.add(s);
        }
    }

    /**
     * mysqldump 产物里这些语句必须跳过:它们要么换个库、要么只是会话开关,
     * 在面板的连接上执行轻则报错重则改错地方(USE / CREATE DATABASE)。
     */
    private boolean shouldSkip(String sql) {
        String head = sql.length() > 32 ? sql.substring(0, 32) : sql;
        head = head.toUpperCase(Locale.ROOT);
        if (head.startsWith("USE ")) {
            return true;
        }
        if (head.startsWith("LOCK TABLES") || head.startsWith("UNLOCK TABLES")) {
            return true;
        }
        if (head.startsWith("SET ")) {
            return true;
        }
        return head.startsWith("CREATE DATABASE") || head.startsWith("DROP DATABASE")
                || head.startsWith("ALTER DATABASE");
    }

    // ==================== 删除 / 清理 ====================

    @Override
    public R delete(String name) {
        try {
            Path dir = dir();
            Path file = resolveSafe(dir, name);
            if (file == null) {
                return R.err("文件名不合法");
            }
            if (!Files.isRegularFile(file)) {
                return R.err("备份文件不存在:" + name);
            }
            Files.delete(file);
            return ok("已删除 " + name, null);
        } catch (Exception e) {
            log.warn("删除备份失败: {}", shortMsg(e.getMessage()));
            return R.err("删除备份失败:" + shortMsg(e.getMessage()));
        }
    }

    /** 只保留最近 KEEP_FILES 个 .sql,多的按时间从旧到新删 */
    private int cleanupOldFiles() {
        int removed = 0;
        try {
            List<Path> files = listSqlFiles(dir());
            for (int i = KEEP_FILES; i < files.size(); i++) {
                try {
                    Files.delete(files.get(i));
                    removed++;
                } catch (IOException e) {
                    log.warn("删除旧备份失败: {} {}", files.get(i).getFileName(), e.getMessage());
                }
            }
        } catch (Exception e) {
            log.warn("清理旧备份失败: {}", shortMsg(e.getMessage()));
        }
        return removed;
    }

    // ==================== 工具 ====================

    private Path dir() {
        String base = logDir == null || logDir.trim().isEmpty() ? "/app/logs" : logDir.trim();
        return Paths.get(base, DIR_NAME).toAbsolutePath().normalize();
    }

    /** 文件名白名单 + 落盘路径必须就在备份目录里(双保险) */
    private Path resolveSafe(Path dir, String name) {
        if (name == null) {
            return null;
        }
        String trimmed = name.trim();
        if (!trimmed.matches(NAME_PATTERN) || trimmed.contains("..")) {
            return null;
        }
        Path file = dir.resolve(trimmed).normalize();
        Path parent = file.getParent();
        return parent != null && parent.equals(dir) ? file : null;
    }

    private List<Path> listSqlFiles(Path dir) throws IOException {
        List<Path> files = new ArrayList<>();
        if (!Files.isDirectory(dir)) {
            return files;
        }
        try (Stream<Path> stream = Files.list(dir)) {
            files = stream
                    .filter(Files::isRegularFile)
                    .filter(p -> p.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".sql"))
                    .collect(Collectors.toList());
        }
        files.sort((a, b) -> {
            try {
                return Long.compare(Files.getLastModifiedTime(b).toMillis(), Files.getLastModifiedTime(a).toMillis());
            } catch (IOException e) {
                return a.getFileName().toString().compareTo(b.getFileName().toString());
            }
        });
        return files;
    }

    private void writeJsonError(HttpServletResponse response, String msg) {
        try {
            if (response.isCommitted()) {
                return;
            }
            response.reset();
            response.setStatus(HttpServletResponse.SC_OK);
            response.setContentType("application/json; charset=utf-8");
            String body = "{\"code\":-1,\"msg\":\"" + jsonEscape(msg) + "\",\"data\":null}";
            response.getOutputStream().write(body.getBytes(StandardCharsets.UTF_8));
            response.flushBuffer();
        } catch (Exception e) {
            log.warn("回写下载错误信息失败: {}", e.getMessage());
        }
    }

    private String jsonEscape(String s) {
        if (s == null) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':
                    sb.append("\\\"");
                    break;
                case '\\':
                    sb.append("\\\\");
                    break;
                case '\n':
                    sb.append(" ");
                    break;
                case '\r':
                    break;
                case '\t':
                    sb.append(" ");
                    break;
                default:
                    if (c < 0x20) {
                        sb.append(' ');
                    } else {
                        sb.append(c);
                    }
            }
        }
        return sb.toString();
    }

    private R ok(String msg, Object data) {
        R r = R.ok(data);
        r.setMsg(msg);
        return r;
    }

    private String snippet(String sql) {
        String s = sql.replace('\n', ' ');
        return s.length() > 160 ? s.substring(0, 160) + "..." : s;
    }

    private String shortMsg(String s) {
        if (s == null) {
            return "未知错误";
        }
        String t = s.trim();
        return t.length() > MAX_MSG ? t.substring(0, MAX_MSG) : t;
    }

    private String readableSize(long bytes) {
        if (bytes >= 1024L * 1024L) {
            return String.format(Locale.ROOT, "%.2f MB", bytes / 1024.0 / 1024.0);
        }
        return String.format(Locale.ROOT, "%.1f KB", bytes / 1024.0);
    }

    /** 一次 dump 的产物 */
    private static class Dump {
        private Path path;
        private int tables;
        private long rows;
    }

    /** 业务错误:消息直接给前端看 */
    private static class BackupException extends RuntimeException {
        BackupException(String msg) {
            super(msg);
        }
    }
}
