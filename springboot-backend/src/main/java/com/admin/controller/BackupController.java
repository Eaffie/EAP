package com.admin.controller;

import com.admin.common.annotation.RequireRole;
import com.admin.common.aop.LogAnnotation;
import com.admin.common.lang.R;
import com.admin.service.BackupService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import javax.servlet.http.HttpServletResponse;
import java.util.Map;

/**
 * <p>
 * 数据库备份 / 恢复前端控制器
 * </p>
 *
 * 全部接口仅管理员可用。备份文件放在后端容器已有的 /app/logs/backups/(backend_logs 卷),
 * 不新增 docker 卷、不改 compose。
 *
 * 下载走 HttpServletResponse 直写(void 返回):返回体是文件流而不是 JSON,
 * 别指望前端按普通接口解析。
 *
 * @since 2026-11-26
 */
@RestController
@RequestMapping("/api/v1/backup")
@CrossOrigin
public class BackupController extends BaseController {

    @Autowired
    private BackupService backupService;

    /** 备份文件列表(文件名、字节数、时间),按时间倒序 */
    @LogAnnotation
    @RequireRole
    @PostMapping("/list")
    public R list() {
        return backupService.list();
    }

    /** 生成备份;includeMonitor 默认 false(监控历史占全库 4MB 的绝大部分,换机器用不上) */
    @LogAnnotation
    @RequireRole
    @PostMapping("/export")
    public R export(@RequestBody(required = false) Map<String, Object> params) {
        return backupService.export(toBool(params == null ? null : params.get("includeMonitor")));
    }

    /** 下载备份文件 */
    @LogAnnotation
    @RequireRole
    @PostMapping("/download")
    public void download(@RequestParam(value = "name", required = false) String name,
                         HttpServletResponse response) {
        backupService.download(name, response);
    }

    /**
     * 上传 .sql 恢复当前库。
     * 没要 confirm 口令:确认由前端弹窗负责(会覆盖当前数据),后端只保证
     * 后缀/大小/串行锁,以及恢复前自动做一份 before_restore_*.sql。
     */
    @LogAnnotation
    @RequireRole
    @PostMapping("/import")
    public R restore(@RequestParam(value = "file", required = false) MultipartFile file,
                     @RequestParam(value = "skipSafetyBackup", required = false) Boolean skipSafetyBackup) {
        return backupService.restore(file, skipSafetyBackup);
    }

    /** 删除一个备份文件 */
    @LogAnnotation
    @RequireRole
    @PostMapping("/delete")
    public R delete(@RequestBody(required = false) Map<String, Object> params) {
        Object name = params == null ? null : params.get("name");
        return backupService.delete(name == null ? null : name.toString());
    }

    /** 前端可能传 true / "true" / 1,都认 */
    private boolean toBool(Object value) {
        if (value == null) {
            return false;
        }
        if (value instanceof Boolean) {
            return (Boolean) value;
        }
        String s = value.toString().trim();
        return "true".equalsIgnoreCase(s) || "1".equals(s);
    }
}
