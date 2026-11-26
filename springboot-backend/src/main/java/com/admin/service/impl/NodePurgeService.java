package com.admin.service.impl;

import com.admin.common.lang.R;
import com.admin.common.task.AccountPauseStore;
import com.admin.common.task.UserNodeNameStore;
import com.admin.common.utils.SubNames;
import com.admin.common.utils.WebSocketServer;
import com.admin.entity.Forward;
import com.admin.entity.Inbound;
import com.admin.entity.InboundLine;
import com.admin.entity.InboundUser;
import com.admin.entity.Node;
import com.admin.entity.Tunnel;
import com.admin.mapper.ForwardMapper;
import com.admin.mapper.InboundLineMapper;
import com.admin.mapper.InboundMapper;
import com.admin.mapper.InboundUserMapper;
import com.admin.mapper.NodeMapper;
import com.admin.mapper.TunnelMapper;
import com.admin.mapper.UserTunnelMapper;
import com.admin.service.ForwardService;
import com.admin.service.InboundService;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import javax.annotation.Resource;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 「清空」一台中转机:把机器上和这台机器有关的线路 / 协议 / 转发服务全部清掉,让它不再对外提供任何服务。
 *
 * 【为什么要有这个】有些机器要退租、要转卖、或者被人滥用了,面板上一条条删线路/协议太慢,
 * 而且漏一条就还留着一个公网口。这里一次性清干净,机器本身(node 行)保留 —— 以后想用还能接着建线路。
 *
 * 【不改节点程序,只用现有 WS 命令】下发给机器的命令全是节点程序早就认识的:
 *   1) SetSingboxConfig(空配置)  —— 入站全没、outbounds 只剩 direct,落地(socks5 账号密码)一起被覆盖掉
 *   2) DeleteService / DeleteChains / DeleteRemoteService —— 走 ForwardService.deleteForward 原有的那一套
 *      (含 GostDeleteFallback 的名字兜底),和面板上「删除转发」发出去的字节完全一样。
 *
 * 【执行顺序】先下发(机器上真清干净),再删库(面板上不再显示)。反过来做的话,一旦下发失败,
 * 库里已经没了这条转发的名字,ForwardService 那套按名字删的逻辑就再也删不掉机器上的服务了。
 * 顺序上和 InboundServiceImpl.pushNodeConfig / deleteLine 一个口径。
 *
 * 【离线为什么拒绝】下发全靠 WS。机器不在线时推空配置必然失败,而库里一删就没有转发名了 ——
 * 机器下次连上来只会剩下一堆没有名字可删的孤儿服务(hybrid 的服务名不带 forwardId_userId 前缀,
 * CheckGostConfigAsync 的孤儿清理认不出来)。所以离线直接拒绝,让车主等机器上线再点。
 *
 * 【删除范围】只动「这台机器作为入口机」的东西:tunnel.in_node_id = 该节点。
 * out_node_id = 该节点的隧道(别的机器当中转、这台机器当出口)不在范围内 —— 那属于出口机的角色,
 * 本次需求没说,动了会影响另一台机器上的线路。
 *
 * 【落地表不动】landing 是中心数据,一台机器清空不影响别的机器继续用同一个落地。
 */
@Slf4j
@Service
public class NodePurgeService {

    @Resource
    private NodeMapper nodeMapper;
    @Resource
    private TunnelMapper tunnelMapper;
    @Resource
    private ForwardMapper forwardMapper;
    @Resource
    private InboundMapper inboundMapper;
    @Resource
    private InboundUserMapper inboundUserMapper;
    @Resource
    private InboundLineMapper inboundLineMapper;
    @Resource
    private UserTunnelMapper userTunnelMapper;
    @Resource
    private ForwardService forwardService;
    @Resource
    private InboundService inboundService;
    @Resource
    private UserNodeNameStore nodeNameStore;
    @Resource
    private AccountPauseStore accountPauseStore;
    @Resource
    private JdbcTemplate jdbc;

    /**
     * 清空一台机器。返回 data = {inboundDeleted, inboundUserDeleted, inboundLineDeleted, forwardDeleted,
     * forwardFailed, forwardFailReasons, tunnelDeleted, userTunnelDeleted, aliasDeleted, nodeNameDeleted,
     * lineSpeedDeleted, staleStateDeleted, errors}。
     */
    public R purge(Long nodeId) {
        if (nodeId == null) {
            return R.err("缺少节点 id");
        }
        Node node = nodeMapper.selectById(nodeId);
        if (node == null) {
            return R.err("节点不存在");
        }
        // 机器必须在线:下面每一条命令都是发给它执行的
        Set<Long> online = WebSocketServer.connectedNodeIds();
        if (!online.contains(nodeId)) {
            return R.err("中转机不在线,无法清空:请等这台机器上的节点程序连上面板再试"
                    + "(面板显示「在线」只代表库里的状态,清空要看节点程序有没有真的连着)");
        }

        // ---------- 1. 先把机器上的东西清掉 ----------

        // 1.1 空 sing-box 配置:所有入站消失,出站只剩 direct —— 落地账号密码随之从 sing-box.json 里消失
        R push = inboundService.pushNodeSingboxEmpty(nodeId);
        if (push.getCode() != 0) {
            return push;
        }

        // 1.2 该机器的隧道 → 隧道下全部转发,逐条走面板原有的删除逻辑(DeleteService/DeleteChains/...)
        List<Tunnel> tunnels = tunnelMapper.selectList(new QueryWrapper<Tunnel>().eq("in_node_id", nodeId));
        List<Long> tunnelIds = new ArrayList<>();
        if (tunnels != null) {
            for (Tunnel t : tunnels) {
                tunnelIds.add(t.getId());
            }
        }
        List<Forward> forwards = tunnelIds.isEmpty() ? new ArrayList<>()
                : forwardMapper.selectList(new QueryWrapper<Forward>().in("tunnel_id", tunnelIds));
        if (forwards == null) {
            forwards = new ArrayList<>();
        }

        int forwardOk = 0;
        int forwardFailed = 0;
        List<String> forwardFailReasons = new ArrayList<>();
        Set<Long> forwardIds = new LinkedHashSet<>();
        for (Forward f : forwards) {
            forwardIds.add(f.getId());
            try {
                R r = forwardService.deleteForward(f.getId());
                if (r != null && r.getCode() == 0) {
                    forwardOk++;
                } else {
                    forwardFailed++;
                    forwardFailReasons.add("转发[" + f.getId() + " 端口 " + f.getInPort() + "]"
                            + (r == null ? "无响应" : r.getMsg()));
                }
            } catch (Exception e) {
                // 单条炸了不能拖垮整批(和 pushNodeConfig 一个口径)
                forwardFailed++;
                forwardFailReasons.add("转发[" + f.getId() + "]"
                        + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
                log.warn("清空节点 {} 时删除转发 {} 失败: {}", nodeId, f.getId(), e.getMessage());
            }
        }

        // ---------- 2. 再清库(机器上已经清了,库里的名字删掉才安全) ----------
        List<String> errors = new ArrayList<>();

        // 2.1 该机器上的入站(先查出来:下面的 inbound_user / 别名清理都要用)
        List<Inbound> inbounds = inboundMapper.selectList(new QueryWrapper<Inbound>().eq("node_id", nodeId));
        if (inbounds == null) {
            inbounds = new ArrayList<>();
        }
        List<Long> inboundIds = new ArrayList<>();
        for (Inbound in : inbounds) {
            inboundIds.add(in.getId());
        }

        // 2.2 inbound_user(车友在这台机器各入站里的凭证 + 分配)
        List<InboundUser> inboundUsers = inboundIds.isEmpty() ? new ArrayList<>()
                : inboundUserMapper.selectList(new QueryWrapper<InboundUser>().in("inbound_id", inboundIds));
        if (inboundUsers == null) {
            inboundUsers = new ArrayList<>();
        }
        int inboundUserDeleted = 0;
        if (!inboundIds.isEmpty()) {
            inboundUserDeleted = inboundUserMapper.delete(new QueryWrapper<InboundUser>().in("inbound_id", inboundIds));
        }

        // 2.3 inbound_line(车友 × 这台机器 × 落地的线路,含各自的订阅 token / 配额)
        List<InboundLine> lines = inboundLineMapper.selectList(new QueryWrapper<InboundLine>().eq("node_id", nodeId));
        if (lines == null) {
            lines = new ArrayList<>();
        }
        int inboundLineDeleted = inboundLineMapper.delete(new QueryWrapper<InboundLine>().eq("node_id", nodeId));

        // 2.4 inbound(协议本身)
        int inboundDeleted = inboundMapper.delete(new QueryWrapper<Inbound>().eq("node_id", nodeId));

        // 2.5 剩下没删掉的 forward 行(步骤 1.2 删失败的那些):机器上可能还留着服务,
        //     但库里必须归零,否则面板上这台机器永远挂着删不掉的条目
        int forwardDeleted = forwardOk;
        int leftoverForwards = 0;
        if (!tunnelIds.isEmpty()) {
            leftoverForwards = forwardMapper.delete(new QueryWrapper<Forward>().in("tunnel_id", tunnelIds));
            forwardDeleted += leftoverForwards;
        }

        // 2.6 user_tunnel(车友在这台机器隧道上的权限/额度)
        int userTunnelDeleted = 0;
        if (!tunnelIds.isEmpty()) {
            userTunnelDeleted = userTunnelMapper.delete(
                    new QueryWrapper<com.admin.entity.UserTunnel>().in("tunnel_id", tunnelIds));
        }

        // 2.7 tunnel(这台机器的隧道;自动隧道 inbound-tunnel-nodeX 以后需要时会自动重建)
        int tunnelDeleted = tunnelMapper.delete(new QueryWrapper<Tunnel>().eq("in_node_id", nodeId));

        // 2.8 车友给这台机器起的名字:线路别名(机器|落地)、协议名、转发名
        int aliasDeleted = 0;
        for (InboundLine l : lines) {
            try {
                nodeNameStore.deleteUserLine(l.getUserId(), SubNames.lineKey(nodeId, l.getLandingId()));
                aliasDeleted++;
            } catch (Exception e) {
                errors.add("清线路别名(车友 " + l.getUserId() + ")失败:" + e.getMessage());
            }
        }
        int nodeNameDeleted = 0;
        for (InboundUser iu : inboundUsers) {
            try {
                nodeNameStore.deleteUserInbound(iu.getUserId(), iu.getInboundId());
                nodeNameDeleted++;
            } catch (Exception e) {
                errors.add("清协议名(车友 " + iu.getUserId() + ")失败:" + e.getMessage());
            }
        }
        for (Long fid : forwardIds) {
            nodeNameStore.deleteForward(fid);
        }

        // 2.9 这台机器上过期的自动暂停状态(forward 没了,这些记录以后不该再影响同 id 的新转发)
        int staleStateDeleted = 0;
        for (Long fid : forwardIds) {
            accountPauseStore.remove(fid);
        }
        if (!forwardIds.isEmpty()) {
            try {
                staleStateDeleted = jdbc.update("DELETE FROM `auto_pause_skip` WHERE `forward_id` IN ("
                        + placeholders(forwardIds.size()) + ")", forwardIds.toArray());
            } catch (Exception e) {
                errors.add("清自动暂停跳过记录失败:" + e.getMessage());
            }
        }

        // 2.10 线路级限速规则(绑在这台机器上的;普通规则 node_id 为空,不受影响)
        int lineSpeedDeleted = 0;
        try {
            lineSpeedDeleted = jdbc.update("DELETE FROM `speed_limit` WHERE `node_id` = ?", nodeId);
        } catch (Exception e) {
            errors.add("清线路级限速失败:" + e.getMessage());
        }

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("nodeId", nodeId);
        data.put("nodeName", node.getName());
        data.put("inboundDeleted", inboundDeleted);
        data.put("inboundUserDeleted", inboundUserDeleted);
        data.put("inboundLineDeleted", inboundLineDeleted);
        data.put("forwardDeleted", forwardDeleted);
        data.put("forwardFailed", forwardFailed);
        data.put("forwardFailReasons", forwardFailReasons);
        data.put("tunnelDeleted", tunnelDeleted);
        data.put("userTunnelDeleted", userTunnelDeleted);
        data.put("aliasDeleted", aliasDeleted);
        data.put("nodeNameDeleted", nodeNameDeleted);
        data.put("lineSpeedDeleted", lineSpeedDeleted);
        data.put("staleStateDeleted", staleStateDeleted);
        data.put("errors", errors);
        log.info("清空节点 {}「{}」:协议 {} 条、分配 {} 条、线路 {} 条、转发 {} 条(失败 {})、隧道 {} 条",
                nodeId, node.getName(), inboundDeleted, inboundUserDeleted, inboundLineDeleted,
                forwardDeleted, forwardFailed, tunnelDeleted);
        return R.ok(data);
    }

    private static String placeholders(int n) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < n; i++) {
            if (i > 0) {
                sb.append(',');
            }
            sb.append('?');
        }
        return sb.toString();
    }
}
