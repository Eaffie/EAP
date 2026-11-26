package com.admin.controller;


import com.admin.common.annotation.RequireRole;
import com.admin.common.aop.LogAnnotation;
import com.admin.common.dto.NodeDto;
import com.admin.common.dto.NodeUpdateDto;
import com.admin.common.lang.R;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/**
 * <p>
 *  前端控制器
 * </p>
 *
 * @since 2025-06-03
 */
@RestController
@CrossOrigin
@RequestMapping("/api/v1/node")
public class NodeController extends BaseController {

    @LogAnnotation
    @RequireRole
    @PostMapping("/create")
    public R create(@Validated @RequestBody NodeDto nodeDto) {
        return nodeService.createNode(nodeDto);
    }


    @LogAnnotation
    @RequireRole
    @PostMapping("/list")
    public R list() {
        return nodeService.getAllNodes();
    }

    @LogAnnotation
    @RequireRole
    @PostMapping("/update")
    public R update(@Validated @RequestBody NodeUpdateDto nodeUpdateDto) {
        return nodeService.updateNode(nodeUpdateDto);
    }

    @LogAnnotation
    @RequireRole
    @PostMapping("/delete")
    public R delete(@RequestBody Map<String, Object> params) {
        Long id = Long.valueOf(params.get("id").toString());
        return nodeService.deleteNode(id);
    }

    @LogAnnotation
    @RequireRole
    @PostMapping("/install")
    public R getInstallCommand(@RequestBody Map<String, Object> params) {
        Long id = Long.valueOf(params.get("id").toString());
        return nodeService.getInstallCommand(id);
    }

    @javax.annotation.Resource
    private com.admin.service.impl.NodeIpv6Switch nodeIpv6Switch;

    /** 开 IPv6 双栈:自动隧道上的转发监听切到 :端口(双栈),全部成功才保存 */
    @LogAnnotation
    @RequireRole
    @PostMapping("/enable-ipv6")
    public R enableIpv6(@RequestBody Map<String, Object> params) {
        Object id = params == null ? null : params.get("nodeId");
        return id == null ? R.err("缺少节点") : nodeIpv6Switch.enable(Long.valueOf(id.toString()));
    }

    /** 关 IPv6 双栈:切回 0.0.0.0:端口 */
    @LogAnnotation
    @RequireRole
    @PostMapping("/disable-ipv6")
    public R disableIpv6(@RequestBody Map<String, Object> params) {
        Object id = params == null ? null : params.get("nodeId");
        return id == null ? R.err("缺少节点") : nodeIpv6Switch.disable(Long.valueOf(id.toString()));
    }

    @javax.annotation.Resource
    private com.admin.service.impl.NodePurgeService nodePurgeService;

    /**
     * 「清空」这台中转机:所有线路(直连/中转)、协议、公网转发服务全部清掉,
     * 落地的 socks5 账号密码也从这台机器的 sing-box.json 里覆盖掉;node 行本身保留。
     * 不可恢复(配置和分配都删了,只能重建),前端点之前会弹一次红色二次确认;机器离线直接拒绝。
     */
    @LogAnnotation
    @RequireRole
    @PostMapping("/purge")
    public R purge(@RequestBody Map<String, Object> params) {
        Object id = params == null ? null : params.get("nodeId");
        return id == null ? R.err("缺少节点") : nodePurgeService.purge(Long.valueOf(id.toString()));
    }

}
