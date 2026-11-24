import { useState, useEffect } from "react";
import { Button } from "@heroui/button";
import { Input } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter } from "@heroui/modal";
import { Chip } from "@heroui/chip";
import { Autocomplete, AutocompleteItem } from "@heroui/autocomplete";
import { DatePicker } from "@heroui/date-picker";
import { parseDate } from "@internationalized/date";
import toast from "react-hot-toast";
import { toastResult } from "@/utils/partial-success";
import {
  getInboundList,
  createInbound,
  oneClickInbound,
  deleteInbound,
  assignAllToUser,
  assignSelf,
  getNodeList,
  getAllUsers,
  getSpeedLimitList,
  setLineSpeed,
  getLineSpeeds,
  getLineStats,
} from "@/api";
import { copyTextToClipboard } from "@/utils/clipboard";
import { SNI_PRESETS, DEFAULT_SNI, cleanSni } from "@/config/sni";
import { SubQr } from "@/components/sub-qr";
import { getSubBase } from "@/utils/sub-base";

/** 字节 → 人类可读(GB/TB) */
function fmtUsed(bytes: number): string {
  if (!bytes || bytes <= 0) return "0";
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1024) return (gb / 1024).toFixed(2) + " TB";
  if (gb >= 100) return gb.toFixed(0) + " GB";
  return gb.toFixed(1) + " GB";
}

/** 建立到现在几天(不足一天算 1 天,时间未知返回空) */
function daysSince(ts: number): string {
  if (!ts || ts <= 0) return "";
  const d = Math.floor((Date.now() - ts) / 86400000);
  return Math.max(d, 1) + " 天";
}

/**
 * 直连线路 · 表格模式。
 * 一条直连入站 = 一行(不再按机器合并),每行的按钮只作用于该行那条入站。
 * 直连没有落地,所以不限速/用量都按「机器 × 直连」这条线路算。
 */
export default function InboundPage() {
  const [inbounds, setInbounds] = useState<any[]>([]);
  const [nodes, setNodes] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [speedRules, setSpeedRules] = useState<any[]>([]);

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<any>({ nodeId: null, protocol: "vless", sni: DEFAULT_SNI, dest: "", remark: "" });
  const [createLoading, setCreateLoading] = useState(false);

  const [oneClickOpen, setOneClickOpen] = useState(false);
  const [oneClickNodeId, setOneClickNodeId] = useState<number | null>(null);
  const [oneClickSni, setOneClickSni] = useState<string>(DEFAULT_SNI);
  const [oneClickLoading, setOneClickLoading] = useState(false);

  // 行内「分配用户」:只分配这一行那条入站(只分配,链接去「用户管理」拿)
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignForm, setAssignForm] = useState<any>({ nodeId: null, lineName: "", inboundIds: [], userId: null, speedId: null, expDate: null, flowGb: null });
  const [assignLoading, setAssignLoading] = useState(false);

  // 线路级限速 / 用量:直连没有落地,key 统一用「机器id-落地id」(落地为空时是 "机器id-null")
  const [lineSpeeds, setLineSpeeds] = useState<Record<string, number>>({});
  const [lineStats, setLineStats] = useState<Record<string, { used: number; createdAt: number }>>({});

  // 「我自己用」:一键开给当前管理员自己,完事直接把订阅链接弹出来
  const [selfLoading, setSelfLoading] = useState<string | null>(null);
  const [selfSubUrl, setSelfSubUrl] = useState<string>("");
  const [selfOpen, setSelfOpen] = useState(false);
  // 订阅链接的域名部分永远是【面板地址】,每条线路点出来长得几乎一样,
  // 只有末尾 token 不同 —— 不写清楚是哪条线路,很容易以为"点第二个弹的还是第一个"
  const [selfLineName, setSelfLineName] = useState<string>("");

  // 线路级限速弹窗:直连线路的 landingId 恒为空
  const [speedOpen, setSpeedOpen] = useState(false);
  const [speedSaving, setSpeedSaving] = useState(false);
  const [speedForm, setSpeedForm] = useState<any>({ nodeId: null, landingId: null, lineName: "", speed: 0 });

  /** 线路 key:和后端「机器id + '-' + 落地id」一致(落地为空 → "null") */
  const lineKey = (nodeId: any, landingId: any) => `${nodeId}-${landingId ?? null}`;

  /** 这条入站属于哪台机器(机器删了就显示节点 id,别让整行消失) */
  const nodeNameOf = (nodeId: number) => nodes.find((n) => n.id === nodeId)?.name || `机器#${nodeId}`;

  const handleAssignSelf = async (ib: any) => {
    const key = `${ib.nodeId}-${ib.id}`;
    setSelfLoading(key);
    setSelfLineName(`${nodeNameOf(ib.nodeId)} · ${protoLabel(ib.protocol)}`);
    try {
      // inboundIds = 只开这一条入站,不动这台机器上的其它协议
      const res = await assignSelf({ nodeId: ib.nodeId, inboundIds: [ib.id] });
      if (res.code === 0 && res.data?.subToken) {
        // 设了「订阅地址(给车友的)」就用它开头,没设 = 网页地址(和以前一样)
        setSelfSubUrl(`${await getSubBase()}/api/v1/open_api/sub?token=${res.data.subToken}`);
        setSelfOpen(true);
        loadAll();
      } else {
        toast.error(res.msg || "开通失败");
      }
    } catch (e) {
      toast.error("开通失败");
    }
    setSelfLoading(null);
  };

  const loadAll = async () => {
    try {
      const [ib, nd, us, sp] = await Promise.all([
        getInboundList(),
        getNodeList(),
        getAllUsers(),
        getSpeedLimitList(),
      ]);
      if (ib.code === 0) setInbounds(ib.data || []);
      if (nd.code === 0) setNodes(nd.data || []);
      if (us.code === 0) {
        const d: any = us.data;
        setUsers(Array.isArray(d) ? d : (d && d.records ? d.records : []));
      }
      if (sp.code === 0) setSpeedRules(sp.data || []);
      // 线路用量/限速:失败不影响主列表
      getLineStats().then((r: any) => {
        if (r.code === 0) {
          const m: Record<string, { used: number; createdAt: number }> = {};
          (r.data || []).forEach((x: any) => {
            m[`${x.nodeId}-${x.landingId ?? null}`] = { used: x.used || 0, createdAt: x.createdAt || 0 };
          });
          setLineStats(m);
        }
      }).catch(() => {});
      getLineSpeeds().then((r: any) => {
        if (r.code === 0) {
          const m: Record<string, number> = {};
          (r.data || []).forEach((x: any) => { m[`${x.nodeId}-${x.landingId ?? null}`] = x.speed || 0; });
          setLineSpeeds(m);
        }
      }).catch(() => {});
    } catch (e) {
      toast.error("加载失败");
    }
  };

  useEffect(() => {
    loadAll();
  }, []);

  const protoLabel = (p: string) =>
    (({ vless: "VLESS-Reality", trojan: "Trojan-Reality", vmess: "VMess", shadowsocks: "Shadowsocks-2022", hysteria2: "Hysteria2", tuic: "TUIC", anytls: "AnyTLS" } as any)[p] || p);
  const isReality = (p: string) => p === "vless" || p === "trojan";

  const handleCreate = async () => {
    if (!createForm.nodeId) return toast.error("请选择节点");
    if (isReality(createForm.protocol) && !createForm.sni) return toast.error("Reality 协议需要填 SNI");
    setCreateLoading(true);
    try {
      // 界面上「VMess + WebSocket」是一个独立选项,但后端没有 vmess-ws 这个协议 ——
      // 传输层是 vmess 的修饰,不是另一种协议。所以在这儿拆开:protocol=vmess + transport=ws。
      const isWs = createForm.protocol === "vmess-ws";
      const payload: any = {
        nodeId: createForm.nodeId,
        protocol: isWs ? "vmess" : createForm.protocol,
        remark: createForm.remark,
      };
      if (isWs) {
        payload.transport = "ws";
        payload.wsPath = createForm.wsPath || "";   // 留空由后端随机生成
        payload.wsHost = createForm.wsHost || "";
      }
      if (isReality(createForm.protocol)) {
        payload.sni = cleanSni(createForm.sni);
        payload.dest = createForm.dest;
      }
      const res = await createInbound(payload);
      if (res.code === 0) {
        toast.success("入站已创建");
        setCreateOpen(false);
        loadAll();
      } else {
        toast.error(res.msg || "创建失败");
      }
    } catch (e) {
      toast.error("创建失败");
    }
    setCreateLoading(false);
  };

  const handleOneClick = async () => {
    if (!oneClickNodeId) return toast.error("请选择节点");
    setOneClickLoading(true);
    try {
      const res = await oneClickInbound(oneClickNodeId, cleanSni(oneClickSni));
      // 半成功(「已入库,但下发配置失败」「中断…已成功 3 个」)也要关弹窗:
      // 协议是真建出来了。以前它走 else 分支报红条、列表不刷新、弹窗还开着,
      // 用户十有八九再点一次 —— 那会重复建、撞端口。
      if (toastResult(res, "一键添加完成:整机全套协议已建好", "一键添加失败", toast)) {
        setOneClickOpen(false);
      }
      // 真失败也刷:失败常常是建到一半撞的,列表得回到面板真实的样子,
      // 否则用户是在对着幻影操作。
      loadAll();
    } catch (e) {
      toast.error("一键添加失败");
    }
    setOneClickLoading(false);
  };

  const openRowAssign = (ib: any) => {
    setAssignForm({
      nodeId: ib.nodeId,
      lineName: `${nodeNameOf(ib.nodeId)} · ${protoLabel(ib.protocol)}${ib.remark ? " · " + ib.remark : ""}`,
      inboundIds: [ib.id],
      userId: null,
      speedId: null,
      expDate: null,
      flowGb: null,
    });
    setAssignOpen(true);
  };

  const handleNodeAssign = async () => {
    if (!assignForm.userId) return toast.error("请选择车友");
    setAssignLoading(true);
    try {
      // inboundIds:只分配这一行那条入站(线路的配额/到期照常按「车友 × 机器 × 直连」记)
      const payload: any = { userId: assignForm.userId, nodeId: assignForm.nodeId, inboundIds: assignForm.inboundIds };
      if (assignForm.speedId) payload.speedId = assignForm.speedId;
      // 到期直接选日期(当天 23:59:59 截止),比填"多少天"直观,续费也只是把日期往后改
      if (assignForm.expDate) payload.expTime = new Date(`${assignForm.expDate}T23:59:59`).getTime();
      if (assignForm.flowGb) payload.flow = Math.round(assignForm.flowGb); // 单位 GB(线路配额按 GB 存)
      const res = await assignAllToUser(payload);
      if (res.code === 0) {
        {
          const a = res.data?.assigned ?? 0, u = res.data?.updated ?? 0;
          toast.success(
            a > 0
              ? `已分配 ${a} 个协议` + (u ? `,更新 ${u} 个` : "") + " · 订阅链接去「用户管理」拿"
              : u > 0
              ? `已更新这条线路的限速/到期/流量(${u} 个协议)`
              : "配额和到期已更新"
          );
        }
        setAssignOpen(false);
        loadAll();
      } else {
        toast.error(res.msg || "分配失败");
      }
    } catch (e) {
      toast.error("分配失败");
    }
    setAssignLoading(false);
  };

  // 清空该条:只删这一行那条入站(连带它的转发、用户分配),不动同机器的其它协议
  const handleClearOne = async (ib: any) => {
    const label = `${nodeNameOf(ib.nodeId)} · ${protoLabel(ib.protocol)}${ib.remark ? " · " + ib.remark : ""}`;
    if (!window.confirm(`确定清空「${label}」这一条直连协议?(连带其转发/用户;同机其它协议不受影响)`)) return;
    const res = await deleteInbound(ib.id);
    if (res.code === 0) {
      toast.success("已清空该条");
      loadAll();
    } else {
      toast.error(res.msg || "清空失败");
    }
  };

  // ===== 线路级限速(直连线路 = 机器 × 直连) =====
  const openSpeed = (ib: any) => {
    setSpeedForm({
      nodeId: ib.nodeId,
      landingId: null,
      lineName: `${nodeNameOf(ib.nodeId)} · ${protoLabel(ib.protocol)}${ib.remark ? " · " + ib.remark : ""}`,
      speed: lineSpeeds[lineKey(ib.nodeId, ib.landingId)] || 0,
    });
    setSpeedOpen(true);
  };

  const handleSaveSpeed = async () => {
    const sp = Number(speedForm.speed);
    if (!Number.isFinite(sp) || sp < 0) return toast.error("填个不小于 0 的数字");
    setSpeedSaving(true);
    try {
      // 直连没有落地:landingId 传 null,后端按「机器 × 直连」这条线路存
      const res = await setLineSpeed(speedForm.nodeId, null, Math.round(sp));
      if (res.code === 0) {
        toast.success(sp > 0 ? `已把这条线路限速定为 ${sp} MB/s 并下发` : "已解除这条线路的限速");
        setSpeedOpen(false);
        loadAll();
      } else {
        toast.error(res.msg || "保存失败");
      }
    } catch (e) {
      toast.error("保存失败");
    }
    setSpeedSaving(false);
  };

  // 直连线路只管【直连】协议(landingId 为空);中转的协议在「中转」页管。
  // 一条直连入站 = 一行。
  const directInbounds = inbounds.filter((ib) => !ib.landingId);

  return (
    <div className="p-4 space-y-4">
      <div className="flex justify-between items-center">
        <h1 className="text-xl font-bold">直连线路</h1>
        <div className="flex gap-2">
          <Button
            color="secondary"
            onPress={() => {
              setOneClickNodeId(null);
              setOneClickOpen(true);
            }}
          >
            ⚡ 一键搭建整机协议
          </Button>
          <Button
            color="primary"
            variant="flat"
            onPress={() => {
              setCreateForm({ nodeId: null, protocol: "vless", sni: DEFAULT_SNI, dest: "", remark: "" });
              setCreateOpen(true);
            }}
          >
            单独加一个协议
          </Button>
        </div>
      </div>

      <div className="text-xs text-default-500">
        直连 = 协议在本机直接出网,一条入站一行。「分配用户」「我自己用」「清空该条」都只作用于当前这一行那条入站。
      </div>

      {/* 真表格:浏览器原生按列对齐,列宽自动取该列最宽内容 */}
      {directInbounds.length > 0 && (
        <div className="rounded-xl border border-default-200 overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-default-100 text-xs text-default-600">
                <th className="text-left font-medium px-3 py-2 whitespace-nowrap">中转机</th>
                <th className="text-left font-medium px-3 py-2 whitespace-nowrap">协议</th>
                <th className="text-left font-medium px-3 py-2 whitespace-nowrap">备注</th>
                <th className="text-right font-medium px-3 py-2 whitespace-nowrap">已用流量</th>
                <th className="text-right font-medium px-3 py-2 whitespace-nowrap">已用天数</th>
                <th className="text-left font-medium px-3 py-2 whitespace-nowrap">限速</th>
                <th className="text-right font-medium px-3 py-2 whitespace-nowrap">操作</th>
              </tr>
            </thead>
            <tbody>
              {directInbounds.map((ib, idx) => {
                const n = nodes.find((x) => x.id === ib.nodeId);
                const online = n?.status === 1;
                // 直连没有落地:限速/用量按「机器 × 直连」这条线路取,和后端的分组口径一致
                const st = lineStats[lineKey(ib.nodeId, ib.landingId)];
                const sp = lineSpeeds[lineKey(ib.nodeId, ib.landingId)] || 0;
                return (
                  <tr
                    key={ib.id}
                    className={"border-t border-default-100 " + (idx % 2 === 1 ? "bg-default-50" : "")}
                  >
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="flex items-center gap-2">
                        <span className="font-semibold">🖥️ {nodeNameOf(ib.nodeId)}</span>
                        <Chip size="sm" variant="flat" color={online ? "success" : "default"}>{online ? "在线" : "离线"}</Chip>
                      </span>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <Chip size="sm" variant="flat" color="secondary">{protoLabel(ib.protocol)}</Chip>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-xs text-default-600">{ib.remark || "-"}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-right text-xs tabular-nums">
                      {fmtUsed(st?.used || 0)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-right text-xs tabular-nums text-default-500">
                      {st?.createdAt ? daysSince(st.createdAt) : "-"}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <Button
                        size="sm"
                        variant="flat"
                        color={sp > 0 ? "warning" : "default"}
                        className="min-w-0 h-7 px-2 text-xs"
                        onPress={() => openSpeed(ib)}
                      >
                        {sp > 0 ? `${sp} MB/s` : "不限速"}
                      </Button>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="flex items-center justify-end gap-1">
                        <Button
                          size="sm"
                          color="primary"
                          className="min-w-0 h-7 px-2 text-xs"
                          onPress={() => openRowAssign(ib)}
                        >
                          👤 分配用户
                        </Button>
                        {/* 自己用不必先建车友再分配:一键开给当前管理员,不限速不限量不到期 */}
                        <Button
                          size="sm"
                          color="success"
                          variant="flat"
                          className="min-w-0 h-7 px-2 text-xs"
                          isLoading={selfLoading === `${ib.nodeId}-${ib.id}`}
                          onPress={() => handleAssignSelf(ib)}
                        >
                          🔑 我自己用
                        </Button>
                        <Button
                          size="sm"
                          color="danger"
                          variant="flat"
                          className="min-w-0 h-7 px-2 text-xs"
                          onPress={() => handleClearOne(ib)}
                        >
                          清空该条
                        </Button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {directInbounds.length === 0 && (
        <div className="text-center text-default-400 py-8">还没有协议,点右上角「⚡ 一键搭建整机协议」在某台机器上把全套协议建出来</div>
      )}

      {/* 「我自己用」结果:直接把订阅链接给出来,不用再去用户管理找 */}
      <Modal isOpen={selfOpen} onClose={() => setSelfOpen(false)} size="2xl">
        <ModalContent>
          <ModalHeader className="flex flex-col gap-1">
            <span>🔑 已开给你自己(不限速 · 不限流量 · 不限到期)</span>
            {selfLineName && (
              <span className="text-sm font-normal text-default-500">
                线路:<b className="text-foreground">{selfLineName}</b>
              </span>
            )}
          </ModalHeader>
          <ModalBody className="space-y-2">
            <div className="text-sm text-default-500">
              这条订阅是给你自己用的,复制到 v2rayN / 小火箭 里就能用。以后随时在「我的订阅」页也能找到。
            </div>
            <div className="text-xs text-default-400 bg-default-100 rounded-lg px-3 py-2">
              💡 链接前半段是<b>面板地址</b>,所以每条线路点出来都一样 —— 真正区分线路的是末尾的
              <b> token</b>。拉下来的节点才是这条线路的。
            </div>
            <Input
              readOnly
              value={selfSubUrl}
              onClick={(e: any) => { if (e.target?.select) e.target.select(); }}
            />
            <SubQr url={selfSubUrl} />
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={() => setSelfOpen(false)}>关闭</Button>
            <Button
              color="primary"
              onPress={async () => {
                (await copyTextToClipboard(selfSubUrl))
                  ? toast.success("已复制订阅链接")
                  : toast.error("复制失败,点框内已全选,按 Ctrl+C");
              }}
            >
              复制订阅链接
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* 行内「分配用户」:只分配这一行那条入站,出一条订阅链接 */}
      <Modal isOpen={assignOpen} onClose={() => setAssignOpen(false)}>
        <ModalContent>
          <ModalHeader>👤 给车友分配「{assignForm.lineName}」</ModalHeader>
          <ModalBody className="space-y-3">
            <div className="text-sm text-default-500">
              只把 <b>{assignForm.lineName}</b> 这 1 条协议分给车友。分配完到「用户管理」页,点该车友的「🔗 订阅链接」拿链接发给他。
            </div>
            <Select
              label="子账号(车友)"
              placeholder="选一个车友"
              selectedKeys={assignForm.userId ? [String(assignForm.userId)] : []}
              onSelectionChange={(k) => setAssignForm({ ...assignForm, userId: Number(Array.from(k)[0]) })}
            >
              {users.map((u) => (<SelectItem key={u.id}>{u.user}</SelectItem>))}
            </Select>
            <Select
              label="限速规则(可空)"
              placeholder="不限速"
              selectedKeys={assignForm.speedId ? [String(assignForm.speedId)] : []}
              onSelectionChange={(k) => setAssignForm({ ...assignForm, speedId: Number(Array.from(k)[0]) })}
            >
              {speedRules.map((s) => (<SelectItem key={s.id}>{s.name}</SelectItem>))}
            </Select>
            <DatePicker
              label="到期日期(留空=永久)"
              value={assignForm.expDate ? parseDate(assignForm.expDate) as any : null}
              onChange={(d: any) => setAssignForm({
                ...assignForm,
                expDate: d ? `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}` : null,
              })}
              showMonthAndYearPickers
              className="cursor-pointer"
              description="到这天 23:59 自动停;续费直接把日期往后改再点一次分配"
            />
            <Input
              type="number"
              label="这条线路的流量配额(GB,留空=不单独限)"
              value={assignForm.flowGb ?? ""}
              onChange={(e) => setAssignForm({ ...assignForm, flowGb: e.target.value ? Number(e.target.value) : null })}
              description="只算这条线路的用量,超了只停这条,车友其它线路照用;留空则只受账号总流量约束"
            />
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={() => setAssignOpen(false)}>关闭</Button>
            <Button color="primary" isLoading={assignLoading} onPress={handleNodeAssign}>分配</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* 线路级限速:整条直连线路(机器)一个上限,不按车友分 */}
      <Modal isOpen={speedOpen} onClose={() => setSpeedOpen(false)}>
        <ModalContent>
          <ModalHeader>⚡ 线路限速「{speedForm.lineName}」</ModalHeader>
          <ModalBody className="space-y-3">
            <div className="text-xs text-default-500">
              这台机器的<b>直连线路</b>共享这个上限,<b>不按车友分</b>:该线路所有客户加起来跑不超过它。
              <br />上传和下载<b>各限这么多</b>,单位是 <b>MB/s</b>(1 MB/s ≈ 8 Mbps)。
            </div>
            <Input
              type="number"
              label="限速(MB/s)"
              value={String(speedForm.speed ?? 0)}
              onChange={(e) => setSpeedForm({ ...speedForm, speed: e.target.value === "" ? 0 : Number(e.target.value) })}
              description="填 0 = 解除限速。参考:5 ≈ 40Mbps,10 ≈ 80Mbps"
            />
            <div className="text-xs text-default-400">
              保存后会立即下发到这台机器;节点离线时只存配置,等它上线再推。
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={() => setSpeedOpen(false)}>取消</Button>
            <Button color="warning" isLoading={speedSaving} onPress={handleSaveSpeed}>保存并下发</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* 一键搭建整机协议:选机器,把所有支持的协议一键全建出来 */}
      <Modal isOpen={oneClickOpen} onClose={() => setOneClickOpen(false)}>
        <ModalContent>
          <ModalHeader>⚡ 一键搭建整机协议</ModalHeader>
          <ModalBody className="space-y-3">
            <div className="text-sm text-default-500">
              在选中的机器上一键建好全部协议:<b>VLESS-Reality、Trojan-Reality、VMess、Hysteria2、TUIC、AnyTLS</b>(端口、密钥、自签证书全自动;端口被占自动上移)。建好后列表里一条协议一行,点该行的「分配用户」出订阅即可。
            </div>
            <Select
              label="机器"
              placeholder="选一台机器(需在线)"
              selectedKeys={oneClickNodeId ? [String(oneClickNodeId)] : []}
              onSelectionChange={(k) => setOneClickNodeId(Number(Array.from(k)[0]))}
            >
              {nodes.map((n) => (
                <SelectItem key={n.id}>{n.name}</SelectItem>
              ))}
            </Select>
            {/* Reality 借壳域名:给个常用列表,也允许自己输 */}
            <Autocomplete
              label="伪装域名(Reality 借壳)"
              allowsCustomValue
              defaultItems={SNI_PRESETS}
              inputValue={oneClickSni}
              onInputChange={(v) => setOneClickSni(v)}
              onSelectionChange={(k) => { if (k) setOneClickSni(String(k)); }}
              description="只影响 VLESS / Trojan 这两个 Reality 协议。可以直接输入别的域名;别用 www.microsoft.com(它上了后量子,握不上手)"
            >
              {(item: any) => <AutocompleteItem key={item.value} description={item.desc || undefined}>{item.label}</AutocompleteItem>}
            </Autocomplete>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={() => setOneClickOpen(false)}>取消</Button>
            <Button color="secondary" isLoading={oneClickLoading} onPress={handleOneClick}>一键全建</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* 单独加一个协议(补充用) */}
      <Modal isOpen={createOpen} onClose={() => setCreateOpen(false)}>
        <ModalContent>
          <ModalHeader>单独加一个协议</ModalHeader>
          <ModalBody className="space-y-3">
            <Select
              label="协议"
              selectedKeys={[createForm.protocol]}
              onSelectionChange={(k) => setCreateForm({ ...createForm, protocol: String(Array.from(k)[0]) })}
              description={
                isReality(createForm.protocol)
                  ? "无域名借 Reality(SNI 借壳),抗封锁强(推荐)"
                  : createForm.protocol === "vmess"
                  ? "VMess:TCP 无 TLS,无域名,兼容各种老客户端"
                  : createForm.protocol === "vmess-ws"
                  ? "VMess over WebSocket。裸 ws(不带 TLS),给需要挂 Nginx/Caddy 反代或 CDN 的人用;直连场景没必要选它,不如用 Reality"
                  : ["hysteria2", "tuic", "anytls"].includes(createForm.protocol)
                  ? "自签证书(无域名);客户端需勾选\"允许不安全/insecure\"。Hy2/TUIC 是 QUIC,快"
                  : "Shadowsocks-2022:无 TLS、任何客户端都通,简单稳"
              }
            >
              <SelectItem key="vless">VLESS-Reality(无域名,推荐)</SelectItem>
              <SelectItem key="trojan">Trojan-Reality(无域名)</SelectItem>
              <SelectItem key="vmess">VMess(无域名,兼容老客户端)</SelectItem>
              <SelectItem key="vmess-ws">VMess + WebSocket(可挂 CDN/反代)</SelectItem>
              <SelectItem key="hysteria2">Hysteria2(QUIC,快,自签证书)</SelectItem>
              <SelectItem key="tuic">TUIC(QUIC,自签证书)</SelectItem>
              <SelectItem key="anytls">AnyTLS(自签证书)</SelectItem>
            </Select>
            <Select
              label="机器"
              placeholder="选一台机器"
              selectedKeys={createForm.nodeId ? [String(createForm.nodeId)] : []}
              onSelectionChange={(k) => setCreateForm({ ...createForm, nodeId: Number(Array.from(k)[0]) })}
            >
              {nodes.map((n) => (
                <SelectItem key={n.id}>{n.name}</SelectItem>
              ))}
            </Select>
            {createForm.protocol === "vmess-ws" && (
              <>
                <Input
                  label="WebSocket 路径"
                  placeholder="留空自动随机,如 /a1b2c3d4"
                  value={createForm.wsPath || ""}
                  onChange={(e) => setCreateForm({ ...createForm, wsPath: e.target.value })}
                  description="留空会自动生成一个随机路径。固定用 / 是被主动探测扫出来的头号特征,别图省事"
                />
                <Input
                  label="Host 头(可选)"
                  placeholder="套 CDN 时填你的域名,直连留空"
                  value={createForm.wsHost || ""}
                  onChange={(e) => setCreateForm({ ...createForm, wsHost: e.target.value })}
                  description="只有前面挂了 CDN 或反代才需要;直连用不上"
                />
              </>
            )}
            {isReality(createForm.protocol) && (
              <>
                <Autocomplete
                  label="伪装域名(Reality 借壳)"
                  allowsCustomValue
                  defaultItems={SNI_PRESETS}
                  inputValue={createForm.sni}
                  onInputChange={(v) => setCreateForm({ ...createForm, sni: v })}
                  onSelectionChange={(k) => { if (k) setCreateForm({ ...createForm, sni: String(k) }); }}
                  description="可以直接输入别的域名;别用 www.microsoft.com(它上了后量子,Reality 握不上手)"
                >
                  {(item: any) => <AutocompleteItem key={item.value} description={item.desc || undefined}>{item.label}</AutocompleteItem>}
                </Autocomplete>
                <Input
                  label="Reality 目标(留空=同 SNI)"
                  value={createForm.dest}
                  onChange={(e) => setCreateForm({ ...createForm, dest: e.target.value })}
                />
              </>
            )}
            <Input
              label="备注"
              value={createForm.remark}
              onChange={(e) => setCreateForm({ ...createForm, remark: e.target.value })}
            />
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={() => setCreateOpen(false)}>取消</Button>
            <Button color="primary" isLoading={createLoading} onPress={handleCreate}>创建</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}
