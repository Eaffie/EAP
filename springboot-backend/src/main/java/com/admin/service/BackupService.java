package com.admin.service;

import com.admin.common.lang.R;
import org.springframework.web.multipart.MultipartFile;

import javax.servlet.http.HttpServletResponse;

/**
 * <p>
 * 数据库备份 / 恢复服务
 * </p>
 *
 * 镜像里是 eclipse-temurin:21-jre-noble,【没有 mysql 客户端】,所以 mysqldump 那条路走不通,
 * 导出/导入全部用 JDBC 自己做。备份文件落在后端容器已有的 /app/logs/backups/
 * (backend_logs 卷),不新增 docker 卷 —— 换面板机时从网页下载 .sql 再上传恢复,不用 SSH 传文件。
 *
 * 导出/导入互斥(ReentrantLock):两个 dump 同时跑会把连接池和磁盘读写搅在一起。
 *
 * @since 2026-11-26
 */
public interface BackupService {

    /** 列出备份目录里的 .sql 文件(文件名、字节数、时间),按时间倒序 */
    R list();

    /** 生成备份;includeMonitor=false 时跳过监控历史表 */
    R export(boolean includeMonitor);

    /** 把备份文件写进 response(Content-Disposition: attachment);出错时回一段 JSON */
    void download(String name, HttpServletResponse response);

    /**
     * 用上传的 .sql 覆盖当前库。
     * 确认交给前端弹窗做(会覆盖当前数据),后端只做硬校验:后缀 .sql、50MB 上限、
     * 导出/导入串行锁,以及恢复前自动一份 before_restore_*.sql(失败则中止)。
     */
    R restore(MultipartFile file, Boolean skipSafetyBackup);

    /** 删除一个备份文件 */
    R delete(String name);
}
