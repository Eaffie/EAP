import { useState, useEffect } from "react";
import { Card, CardBody } from "@heroui/card";
import { Button } from "@heroui/button";
import { Input, Textarea } from "@heroui/input";
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
  oneClickRelay,
  testLanding,
  deleteInboundsByNode,
  assignAllToUser,
  assignSelf,
  getNodeList,
  getAllUsers,
  getSpeedLimitList,
  getLandingList,
  setLineSpeed,
  getLineSpeeds,
  getLineStats,
  updateLanding,
  deleteLanding,
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

/** 搭中转时可勾选的协议。默认只勾 VLESS-Reality */
const PROTO_OPTIONS = [
  { value: "vless", label: "VLESS-Reality" },
  { value: "trojan", label: "Trojan-Reality" },
  { value: "vmess", label: "VMess" },
  { value: "hysteria2", label: "Hysteria2" },
  { value: "tuic", label: "TUIC" },
  { value: "anytls", label: "AnyTLS" },
];

/**
 * 中转落地(原「中转」+「落地管理」合并)。
 *
 * 为什么合成一页:一条中转线路 = 前置机 × 落地,落地不是独立的东西,
 * 而是这条线路的一部分。拆成两页的后果是「搭完中转要改出口,还得切页去找」,
 * 而且落地页上那点信息(名字/串/测/改)放卡片里就够了,不值一个菜单。
 *
 * 卡片格式(三行):
 *   ① 中转机名 + 在线状态 + 协议标签 + 协议数
 *   ② 落地名 + 类型 + 落地 IP + [测一下][编辑]
 *   ③ [分配用户][我自己用][清空该条]
 *
 * 底部单独一块「未挂载的落地」:手工建了却没挂到任何机器的落地,
 * 它们不会出现在上面任何一张卡里,没这块就没地方看/删。
 *
 * 前置机 IP 不显示:和机器名重复。复制按钮不做:落地串本来就是粘进来的。
 * 主卡片上不放「删除」:那条落地正被本卡中转使用,后端一定拒绝,
 * 删除只出现在「未挂载的落地」里(那时才真删得掉)。
 */
export default function RelayPage() {
  const [inbounds, setInbounds] = useState<any[]>([]);
  const [nodes, setNodes] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [speedRules, setSpeedRules] = useState<any[]>([]);
  const [landings, setLandings] = useState<any[]>([]);
  // 线路级限速:key = nodeId-landingId → 速度(MB/s)
  const [lineSpeeds, setLineSpeeds] = useState<Record<string, number>>({});
  // 线路用量:key = nodeId-landingId → { used(字节), createdAt(ms) }
  const [lineStats, setLineStats] = useState<Record<string, { used: number; createdAt: number }>>({});

  const [buildOpen, setBuildOpen] = useState(false);
  const [buildForm, setBuildForm] = useState<any>({ nodeId: null, name: "", link: "", sni: DEFAULT_SNI, protocols: ["vless"] });
  const [buildLoading, setBuildLoading] = useState(false);
  const [testLoading, setTestLoading] = useState(false);
  const [testResult, setTestResult] = useState<any>(null); // {ok, exitIp, latencyMs, skipped, msg}

  const [assignOpen, setAssignOpen] = useState(false);
  const [assignForm, setAssignForm] = useState<any>({ nodeId: null, nodeName: "", protocolCount: 0, userId: null, speedId: null, expDate: null, flowGb: null });
  const [assignLoading, setAssignLoading] = useState(false);

  // 「我自己用」:一键把这条中转开给当前管理员自己,完事直接弹订阅链接
  const [selfLoading, setSelfLoading] = useState<string | null>(null);
  const [selfSubUrl, setSelfSubUrl] = useState<string>("");
  // 中转这边更容易混:同一台前置机可能有好几条落地,弹出来的链接域名部分还都一样
  const [selfLineName, setSelfLineName] = useState<string>("");
  const [selfOpen, setSelfOpen] = useState(false);

  // 新建/编辑落地(原来在「落地管理」页):form.id 有值 = 编辑
  const [landingOpen, setLandingOpen] = useState(false);
  const [landingForm, setLandingForm] = useState<any>({ id: null, name: "", link: "", remark: "", nodeId: null });
  const [landingSaving, setLandingSaving] = useState(false);
  const [landingTestLoading, setLandingTestLoading] = useState(false);
  const [landingTestResult, setLandingTestResult] = useState<any>(null);

  // 卡片行上的快速测试:结果按落地 id 存
  const [rowTesting, setRowTesting] = useState<number | null>(null);
  const [rowResult, setRowResult] = useState<Record<number, any>>({});

  const handleAssignSelf = async (nodeId: number, landingId: any, lineName?: string) => {
    const key = `${nodeId}-${landingId}`;
    setSelfLoading(key);
    setSelfLineName(lineName || "");
    try {
      const res = await assignSelf({ nodeId, relay: true, landingId });
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
      const [ib, nd, us, sp, ld] = await Promise.all([
        getInboundList(),
        getNodeList(),
        getAllUsers(),
        getSpeedLimitList(),
        getLandingList(),
      ]);
      if (ib.code === 0) setInbounds(ib.data || []);
      if (nd.code === 0) setNodes(nd.data || []);
      if (us.code === 0) {
        const d: any = us.data;
        setUsers(Array.isArray(d) ? d : (d && d.records ? d.records : []));
      }
      if (sp.code === 0) setSpeedRules(sp.data || []);
      if (ld.code === 0) setLandings(ld.data || []);
      // 线路限速:和落地一起刷,失败不影响主列表
      getLineStats().then((r: any) => {
        if (r.code === 0) {
          const m: Record<string, { used: number; createdAt: number }> = {};
          (r.data || []).forEach((x: any) => {
            m[`${x.nodeId}-${x.landingId}`] = { used: x.used || 0, createdAt: x.createdAt || 0 };
          });
          setLineStats(m);
        }
      }).catch(() => {});
      getLineSpeeds().then((r: any) => {
        if (r.code === 0) {
          const m: Record<string, number> = {};
          (r.data || []).forEach((x: any) => { m[`${x.nodeId}-${x.landingId}`] = x.speed || 0; });
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
  const landingById = (id: any) => landings.find((l) => l.id === id);

  // 这条落地被谁在用(后端删除时按同一口径拒绝,所以卡片上先算好)
  const usageOf = (landingId: number) => {
    const ibs = inbounds.filter((ib) => ib.landingId === landingId);
    const nodeIds = Array.from(new Set(ibs.map((ib) => ib.nodeId))).filter((x) => x != null) as number[];
    return { count: ibs.length, nodeIds };
  };

  // 卡片上只显示落地 IP:端口/账号/密码不占地方,要看全的进「编辑」
  const landingAddr = (l: any) => {
    const s = String(l?.link || "").trim();
    if (!s) return "";
    if (s.includes("://")) {
      const at = s.match(/@([^:/?#]+)/);            // vless://...@host:port
      if (at) return at[1];
      const head = s.match(/^[a-z0-9]+:\/\/([^:/?#]+)/i);
      const h = head ? head[1] : "";
      // vmess:// 后面是 base64,取出来不是地址,干脆不显示
      return /\./.test(h) ? h : "";
    }
    // 住宅 socks 串: IP:端口:账号:密码
    return s.split(":")[0] || "";
  };

  const handleTest = async () => {
    if (!buildForm.nodeId) return toast.error("先选前置机(要经它测落地)");
    if (!buildForm.link) return toast.error("先粘贴落地链接");
    setTestLoading(true);
    setTestResult(null);
    try {
      const res = await testLanding(buildForm.nodeId, buildForm.link);
      if (res.code === 0) {
        setTestResult(res.data);
        if (res.data?.skipped) toast.success(res.data?.msg || "格式已校验");
        else if (res.data?.ok) toast.success(`通了,出口 IP ${res.data?.exitIp}`);
      } else {
        setTestResult({ ok: false, msg: res.msg });
        toast.error(res.msg || "测试失败");
      }
    } catch (e) {
      toast.error("测试失败");
    }
    setTestLoading(false);
  };

  const handleBuild = async () => {
    if (!buildForm.nodeId) return toast.error("请选择前置机");
    if (!buildForm.link) return toast.error("请粘贴落地链接");
    if (!(buildForm.protocols || []).length) return toast.error("至少选一个协议,不然建出来是个空线路");
    setBuildLoading(true);
    try {
      const res = await oneClickRelay(buildForm.nodeId, buildForm.link, buildForm.name, cleanSni(buildForm.sni), buildForm.protocols);
      // 同 inbound 页:半成功(「中转已入库,但下发配置失败」「中断…已成功 N 个」)
      // 协议是真建出来了,不该报红条、不该把弹窗晾着让人再点一次。
      if (toastResult(res, "一键搭中转完成:整机协议已建好,出口走落地", "搭建失败", toast)) {
        setBuildOpen(false);
      }
      loadAll(); // 真失败也刷,列表要回到面板真实的样子
    } catch (e) {
      toast.error("搭建失败");
    }
    setBuildLoading(false);
  };

  const openNodeAssign = (n: any, landingId: any, landingName: string, count: number) => {
    setAssignForm({ nodeId: n.id, nodeName: n.name, landingId, landingName, protocolCount: count, userId: null, speedId: null, expDate: null, flowGb: null });
    setAssignOpen(true);
  };

  const handleNodeAssign = async () => {
    if (!assignForm.userId) return toast.error("请选择车友");
    setAssignLoading(true);
    try {
      const payload: any = { userId: assignForm.userId, nodeId: assignForm.nodeId, relay: true, landingId: assignForm.landingId };
      if (assignForm.speedId) payload.speedId = assignForm.speedId;
      // 到期直接选日期(当天 23:59:59 截止),续费就是把日期往后改
      if (assignForm.expDate) payload.expTime = new Date(`${assignForm.expDate}T23:59:59`).getTime();
      if (assignForm.flowGb) payload.flow = Math.round(assignForm.flowGb); // 单位 GB(线路配额按 GB 存)
      const res = await assignAllToUser(payload);
      if (res.code === 0) {
        {
          const a = res.data?.assigned ?? 0, u = res.data?.updated ?? 0;
          toast.success(
            a > 0
              ? `已分配 ${a} 个协议` + (u ? `,更新 ${u} 个` : "") + " · 订阅去「用户管理」拿"
              : u > 0
              ? `已更新这条中转的限速/到期/流量(${u} 个协议)`
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

  // 清空该条 = 整张卡片一起干净:
  //   ① 删掉这条线路的全部协议(连带其转发规则、用户分配)
  //   ② 这条落地如果不再被任何机器使用,连落地记录一并删掉 —— 否则卡片消失后
  //      它会掉进「未挂载的落地」里,用户还得再手动删一次,等于清不干净
  //   ③ 还被其它机器用着就只清本机这条,落地保留
  const handleClearNode = async (nodeId: number, nodeName: string, landingId: any, landingName: string) => {
    if (!window.confirm(
      `确定清空「${nodeName} → ${landingName}」这条中转?\n\n` +
      `会删除:这条线路的全部协议、转发规则、用户分配。\n` +
      `落地「${landingName}」如果不再被其它机器使用,也会一并删除。`
    )) return;

    const res = await deleteInboundsByNode(nodeId, true, landingId);
    if (res.code !== 0) {
      toast.error(res.msg || "清空失败");
      return;
    }

    // 落地是否还有人用:重新拉一次最准,别拿旧 state 判断
    let landingRemoved = false;
    if (landingId) {
      try {
        const ib = await getInboundList();
        const remain = (ib.code === 0 ? (ib.data || []) : []).filter((x: any) => x.landingId === landingId);
        if (remain.length === 0) {
          const d = await deleteLanding(landingId);
          landingRemoved = d.code === 0;
        }
      } catch (e) {
        // 落地删不掉不算失败:协议已经清了、卡片已经没了,留条记录不影响使用
      }
    }

    toast.success(landingRemoved ? "已清空该条中转,落地也一并删除" : "已清空该条中转");
    loadAll();
  };

  // ===== 线路级限速 =====
  const [speedOpen, setSpeedOpen] = useState(false);
  const [speedSaving, setSpeedSaving] = useState(false);
  const [speedForm, setSpeedForm] = useState<any>({ nodeId: null, landingId: null, lineName: "", speed: 0 });

  const openSpeed = (n: any, landingId: any, landingName: string) => {
    setSpeedForm({
      nodeId: n.id,
      landingId,
      lineName: `${n.name} → ${landingName}`,
      speed: lineSpeeds[`${n.id}-${landingId}`] || 0,
    });
    setSpeedOpen(true);
  };

  const handleSaveSpeed = async () => {
    const sp = Number(speedForm.speed);
    if (!Number.isFinite(sp) || sp < 0) return toast.error("填个不小于 0 的数字");
    setSpeedSaving(true);
    try {
      const res = await setLineSpeed(speedForm.nodeId, speedForm.landingId, Math.round(sp));
      if (res.code === 0) {
        toast.success(sp > 0 ? `已把整条线路限速定为 ${sp} MB/s 并下发` : "已解除这条线路的限速");
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

  // ===== 落地:新建 / 编辑 / 测 / 删 =====

  // nodeId 传进来 = 从哪张卡片点的(用那台机器去测最真实)
  const openEditLanding = (l: any, testNodeId?: number | null) => {
    setLandingForm({ id: l.id, name: l.name || "", link: l.link || "", remark: l.remark || "", nodeId: testNodeId ?? nodes[0]?.id ?? null });
    setLandingTestResult(null);
    setLandingOpen(true);
  };

  const handleLandingTest = async () => {
    if (!landingForm.nodeId) return toast.error("先选一台前置机(要经它去拨落地)");
    if (!landingForm.link.trim()) return toast.error("先填落地出口");
    setLandingTestLoading(true);
    setLandingTestResult(null);
    try {
      const res = await testLanding(landingForm.nodeId, landingForm.link.trim());
      if (res.code === 0) {
        setLandingTestResult(res.data);
        if (res.data?.skipped) toast.success(res.data?.msg || "格式已校验");
        else if (res.data?.ok) toast.success(`通了,出口 IP ${res.data?.exitIp}`);
      } else {
        setLandingTestResult({ ok: false, msg: res.msg });
        toast.error(res.msg || "测试失败");
      }
    } catch (e) {
      toast.error("测试失败");
    }
    setLandingTestLoading(false);
  };

  // 落地只能在卡片上「编辑」——不再提供"先建一条空落地"的入口:
  // 搭中转时本来就要填一次落地串,单独建出来的落地挂不到任何机器上,只会堆在未挂载区。
  const handleLandingSave = async () => {
    if (!landingForm.id) return toast.error("落地数据异常,刷新页面再试");
    if (!landingForm.name.trim()) return toast.error("给落地起个名字,不然一堆 socks 分不清哪条是哪条");
    if (!landingForm.link.trim()) return toast.error("请填落地出口");
    setLandingSaving(true);
    try {
      const payload = { name: landingForm.name.trim(), link: landingForm.link.trim(), remark: landingForm.remark?.trim() || "" };
      const res = await updateLanding({ id: landingForm.id, ...payload });

      if (res.code === 0) {
        const u = usageOf(landingForm.id);
        toast.success(u.nodeIds.length ? `已保存,并给 ${u.nodeIds.length} 台机器重推了配置(出口已切换)` : "已保存");
        setLandingOpen(false);
        loadAll();
      } else if (res.msg && res.msg.startsWith("落地已改")) {
        // 后端这条是【半成功】:库已经改完,只是有机器没推上(多半离线)。
        // 当成失败会更糟 —— 弹窗不关、列表不刷新,用户会以为改动没保存、再改一遍。
        toast(res.msg, { icon: "⚠️", duration: 8000 });
        setLandingOpen(false);
        loadAll();
      } else {
        toast.error(res.msg || "保存失败");
      }
    } catch (e) {
      toast.error("保存失败");
    }
    setLandingSaving(false);
  };

  const handleLandingDelete = async (l: any) => {
    const u = usageOf(l.id);
    if (u.count > 0) {
      toast.error(`「${l.name}」正在被 ${u.count} 个中转协议使用。先去对应卡片点「清空该条」再删。`, { duration: 8000 });
      return;
    }
    if (!window.confirm(`确定删除落地「${l.name}」?`)) return;
    try {
      const res = await deleteLanding(l.id);
      if (res.code === 0) {
        toast.success("已删除");
        loadAll();
      } else {
        toast.error(res.msg || "删除失败");
      }
    } catch (e) {
      toast.error("删除失败");
    }
  };

  // 卡片行内快速测:优先用这张卡的前置机(那台才是真正会受影响的)
  const handleRowTest = async (l: any, preferNodeId?: number | null) => {
    if (!l) return toast.error("这条落地数据缺失,刷新看看");
    const nid = preferNodeId ?? usageOf(l.id).nodeIds[0] ?? nodes[0]?.id;
    if (!nid) return toast.error("还没有转发机,没法测");
    setRowTesting(l.id);
    try {
      const res = await testLanding(nid, l.link);
      setRowResult((p) => ({ ...p, [l.id]: res.code === 0 ? { ...res.data } : { ok: false, msg: res.msg } }));
      if (res.code !== 0) toast.error(res.msg || "测试失败");
    } catch (e) {
      toast.error("测试失败");
    }
    setRowTesting(null);
  };

  // 中转线路 = 每(前置机 × 落地)一条卡
  const relayLines: any[] = [];
  nodes.forEach((n) => {
    const relayIbs = inbounds.filter((ib) => ib.nodeId === n.id && ib.landingId);
    const lids = Array.from(new Set(relayIbs.map((ib) => ib.landingId)));
    lids.forEach((lid) => {
      relayLines.push({ node: n, landingId: lid, inbounds: relayIbs.filter((ib) => ib.landingId === lid) });
    });
  });

  // 没挂到任何机器的落地(手工建的、清空中转后剩下的)
  const unusedLandings = landings.filter((l) => usageOf(l.id).count === 0);

  const testBadge = (r: any) =>
    !r ? null : r.skipped ? (
      <span className="text-default-500">{r.msg}</span>
    ) : r.ok ? (
      <span className="text-success">✅ {r.exitIp}{r.latencyMs ? ` · ${r.latencyMs}ms` : ""}</span>
    ) : (
      <span className="text-danger">❌ {r.msg || "不通"}</span>
    );

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h1 className="text-xl font-bold">中转落地</h1>
        <div className="flex gap-2">
          <Button
            color="secondary"
            onPress={() => {
              setBuildForm({ nodeId: null, name: "", link: "", sni: DEFAULT_SNI, protocols: ["vless"] });
              setTestResult(null);
              setBuildOpen(true);
            }}
          >
            ⚡ 搭中转
          </Button>
        </div>
      </div>

      <div className="text-xs text-default-500">
        中转 = 前置机搭协议(抗封锁),流量经「落地」出网。车友连的还是前置机的订阅,只是出口 IP 换成落地那台的。换落地就直接点卡片上的「编辑」改串——订阅不变,客户无感。
      </div>

      {/* 真表格:浏览器原生按列对齐,列宽自动取该列最宽内容 */}
      {relayLines.length > 0 && (
        <div className="rounded-xl border border-default-200 overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-default-100 text-xs text-default-600">
                <th className="text-left font-medium px-3 py-2 whitespace-nowrap">中转机</th>
                <th className="text-left font-medium px-3 py-2 whitespace-nowrap">协议</th>
                <th className="text-left font-medium px-3 py-2 whitespace-nowrap">落地</th>
                <th className="text-left font-medium px-3 py-2 whitespace-nowrap">落地 IP</th>
                <th className="text-left font-medium px-3 py-2 whitespace-nowrap">测试/编辑</th>
                <th className="text-right font-medium px-3 py-2 whitespace-nowrap">已用流量</th>
                <th className="text-right font-medium px-3 py-2 whitespace-nowrap">已用天数</th>
                <th className="text-left font-medium px-3 py-2 whitespace-nowrap">限速</th>
                <th className="text-right font-medium px-3 py-2 whitespace-nowrap">操作</th>
              </tr>
            </thead>
            <tbody>
              {relayLines.map((ln, idx) => {
                const n = ln.node;
                const l = landingById(ln.landingId);
                const landingName = l ? `${l.name}(${l.type})` : `落地#${ln.landingId}`;
                const online = n.status === 1;
                const r = rowResult[ln.landingId];
                const st = lineStats[`${n.id}-${ln.landingId}`];
                const sp = lineSpeeds[`${n.id}-${ln.landingId}`] || 0;
                const shown = ln.inbounds.slice(0, 2);
                const rest = ln.inbounds.length - shown.length;
                return (
                  <tr
                    key={`${n.id}-${ln.landingId}`}
                    className={"border-t border-default-100 " + (idx % 2 === 1 ? "bg-default-50" : "")}
                  >
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="flex items-center gap-2">
                        <span className="font-semibold">🖥️ {n.name}</span>
                        <Chip size="sm" variant="flat" color={online ? "success" : "default"}>{online ? "在线" : "离线"}</Chip>
                      </span>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="flex items-center gap-1">
                        {shown.map((ib: any) => (
                          <Chip key={ib.id} size="sm" variant="flat" color="secondary">{protoLabel(ib.protocol)}</Chip>
                        ))}
                        {rest > 0 && <Chip size="sm" variant="flat" color="secondary">+{rest}</Chip>}
                      </span>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="flex items-center gap-1">
                        <Chip size="sm" variant="flat" color="warning">{l ? l.name : `落地#${ln.landingId}`}</Chip>
                        {l && <span className="text-xs text-default-400">{l.type}</span>}
                      </span>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap font-mono text-xs text-default-600">
                      {l ? landingAddr(l) : ""}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="flat"
                          color="secondary"
                          className="min-w-0 h-7 px-2 text-xs"
                          isLoading={rowTesting === ln.landingId}
                          onPress={() => handleRowTest(l, n.id)}
                        >
                          测一下
                        </Button>
                        <Button
                          size="sm"
                          variant="flat"
                          className="min-w-0 h-7 px-2 text-xs"
                          isDisabled={!l}
                          onPress={() => l && openEditLanding(l, n.id)}
                        >
                          编辑
                        </Button>
                        {r && <span className="text-xs">{testBadge(r)}</span>}
                      </span>
                    </td>
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
                        onPress={() => openSpeed(n, ln.landingId, landingName)}
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
                          onPress={() => openNodeAssign(n, ln.landingId, landingName, ln.inbounds.length)}
                        >
                          👤 分配用户
                        </Button>
                        <Button
                          size="sm"
                          color="success"
                          variant="flat"
                          className="min-w-0 h-7 px-2 text-xs"
                          isLoading={selfLoading === `${n.id}-${ln.landingId}`}
                          onPress={() => handleAssignSelf(n.id, ln.landingId, `${n.name} → ${landingName}`)}
                        >
                          🔑 我自己用
                        </Button>
                        <Button
                          size="sm"
                          color="danger"
                          variant="flat"
                          className="min-w-0 h-7 px-2 text-xs"
                          onPress={() => handleClearNode(n.id, n.name, ln.landingId, landingName)}
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

      {relayLines.length === 0 && (
        <div className="text-center text-default-400 py-8">
          还没有中转。点右上角「⚡ 搭中转」→ 选前置机 + 粘贴落地(住宅 socks 或协议链接)→ 测试通 → 搭建。
        </div>
      )}

      {/* 未挂载的落地:卡不到上面任何一行,单独一块,能看能测能删 */}
      {unusedLandings.length > 0 && (
        <>
          <div className="text-sm font-medium text-default-600 pt-2">
            未挂载的落地(没有中转在用,可以直接删)
          </div>
          <div className="space-y-2">
            {unusedLandings.map((l) => {
              const r = rowResult[l.id];
              return (
                <Card key={l.id}>
                  <CardBody className="py-2 px-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-base">🌐</span>
                      <span className="text-sm font-semibold">{l.name}</span>
                      <Chip size="sm" variant="flat" color={l.type === "socks5" ? "warning" : "secondary"}>{l.type}</Chip>
                      <span className="text-xs font-mono text-default-600">{landingAddr(l)}</span>
                      {r && <span className="text-xs">{testBadge(r)}</span>}
                      <div className="ml-auto flex items-center gap-1 flex-wrap">
                        <Button
                          size="sm"
                          variant="flat"
                          color="secondary"
                          className="min-w-0 h-7 px-2 text-xs"
                          isLoading={rowTesting === l.id}
                          onPress={() => handleRowTest(l, null)}
                        >
                          测一下
                        </Button>
                        <Button
                          size="sm"
                          variant="flat"
                          className="min-w-0 h-7 px-2 text-xs"
                          onPress={() => openEditLanding(l, null)}
                        >
                          编辑
                        </Button>
                        <Button
                          size="sm"
                          variant="flat"
                          color="danger"
                          className="min-w-0 h-7 px-2 text-xs"
                          onPress={() => handleLandingDelete(l)}
                        >
                          删除
                        </Button>
                      </div>
                    </div>
                  </CardBody>
                </Card>
              );
            })}
          </div>
        </>
      )}

      {/* 「我自己用」结果:直接把订阅链接给出来 */}
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
              这条中转订阅是给你自己用的,复制到客户端就能用,出口走落地。以后在「我的订阅」页也能找到。
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

      {/* 分配用户(复用直连线路的整机分配) */}
      <Modal isOpen={assignOpen} onClose={() => setAssignOpen(false)}>
        <ModalContent>
          <ModalHeader>👤 中转分配「{assignForm.nodeName} → {assignForm.landingName}」</ModalHeader>
          <ModalBody className="space-y-3">
            <div className="text-sm text-default-500">
              把这条中转的 <b>{assignForm.protocolCount} 个协议</b> 一次分给车友,出口走 {assignForm.landingName}。分配完到「用户管理」拿这条中转订阅链接。
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
              label="这条中转的流量配额(GB,留空=不单独限)"
              value={assignForm.flowGb ?? ""}
              onChange={(e) => setAssignForm({ ...assignForm, flowGb: e.target.value ? Number(e.target.value) : null })}
              description="中转走落地流量成本高,建议单独设:超了只停这条中转,车友的直连线路照用"
            />
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={() => setAssignOpen(false)}>关闭</Button>
            <Button color="primary" isLoading={assignLoading} onPress={handleNodeAssign}>分配</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* 线路级限速:整条中转一个上限,不按车友分 */}
      <Modal isOpen={speedOpen} onClose={() => setSpeedOpen(false)}>
        <ModalContent>
          <ModalHeader>⚡ 线路限速「{speedForm.lineName}」</ModalHeader>
          <ModalBody className="space-y-3">
            <div className="text-xs text-default-500">
              整条线路共享这个上限,<b>不按车友分</b>:该线路所有客户加起来跑不超过它。
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
              保存后会立即下发到转发机;节点离线时只存配置,等它上线再推。
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={() => setSpeedOpen(false)}>取消</Button>
            <Button color="warning" isLoading={speedSaving} onPress={handleSaveSpeed}>保存并下发</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* 编辑落地(只从卡片上的「编辑」进来) */}
      <Modal isOpen={landingOpen} onClose={() => setLandingOpen(false)} size="2xl">
        <ModalContent>
          <ModalHeader>✏️ 编辑落地</ModalHeader>
          <ModalBody className="space-y-3">
            <Input
              label="落地名称"
              placeholder="如 泰国住宅"
              value={landingForm.name}
              onChange={(e) => setLandingForm({ ...landingForm, name: e.target.value })}
            />
            <Textarea
              label="落地出口"
              minRows={2}
              placeholder="住宅socks: IP:端口:账号:密码    协议节点: ss:// / vmess:// / vless:// / trojan:// / hysteria2://"
              value={landingForm.link}
              onChange={(e) => { setLandingForm({ ...landingForm, link: e.target.value }); setLandingTestResult(null); }}
              description="改这一串,车友的订阅链接/UUID/端口都不变,只有出口 IP 会换"
            />
            <Input
              label="备注(可选)"
              value={landingForm.remark}
              onChange={(e) => setLandingForm({ ...landingForm, remark: e.target.value })}
            />
            <Select
              label="经哪台前置机测试"
              placeholder="选一台(测试必须经前置机)"
              selectedKeys={landingForm.nodeId ? [String(landingForm.nodeId)] : []}
              onSelectionChange={(k) => setLandingForm({ ...landingForm, nodeId: Number(Array.from(k)[0]) })}
            >
              {nodes.map((n) => (<SelectItem key={n.id}>{n.name}</SelectItem>))}
            </Select>
            <div className="flex items-center gap-2 flex-wrap">
              <Button size="sm" variant="flat" color="secondary" isLoading={landingTestLoading} onPress={handleLandingTest}>
                🔌 测试落地
              </Button>
              {landingTestResult && <span className="text-xs">{testBadge(landingTestResult)}</span>}
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={() => setLandingOpen(false)}>取消</Button>
            <Button color="primary" isLoading={landingSaving} onPress={handleLandingSave}>保存</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* 搭中转:选前置机 + 内联填落地 + 测试 + 搭建 */}
      <Modal isOpen={buildOpen} onClose={() => setBuildOpen(false)} size="2xl">
        <ModalContent>
          <ModalHeader>⚡ 搭中转</ModalHeader>
          <ModalBody className="space-y-3">
            <div className="text-sm text-default-500">
              选前置机 + 填落地出口 → 测试通了 → 搭建。前置机上建全套协议,流量经落地出网。
            </div>
            <Select
              label="前置机(客户端连的那台)"
              placeholder="选一台前置机(需在线)"
              selectedKeys={buildForm.nodeId ? [String(buildForm.nodeId)] : []}
              onSelectionChange={(k) => { setBuildForm({ ...buildForm, nodeId: Number(Array.from(k)[0]) }); setTestResult(null); }}
            >
              {nodes.map((n) => (<SelectItem key={n.id}>{n.name}</SelectItem>))}
            </Select>
            <Input
              label="落地名称(自己起)"
              placeholder="如 泰国住宅"
              value={buildForm.name}
              onChange={(e) => setBuildForm({ ...buildForm, name: e.target.value })}
            />
            <Textarea
              label="落地出口(粘贴)"
              placeholder="住宅socks: IP:端口:账号:密码    协议节点: ss:// / vmess:// / vless:// / trojan:// / hysteria2://"
              minRows={2}
              value={buildForm.link}
              onChange={(e) => { setBuildForm({ ...buildForm, link: e.target.value }); setTestResult(null); }}
              description="住宅 socks 直接填 IP:端口:账号:密码;机场/别人节点整条分享链接粘进来。测试会经前置机试连、显示出口 IP"
            />
            <div className="flex items-center gap-2">
              <Button size="sm" variant="flat" color="secondary" isLoading={testLoading} onPress={handleTest}>🔌 测试落地</Button>
              {testResult && (
                testResult.skipped ? (
                  <span className="text-xs text-default-500">{testResult.msg}</span>
                ) : testResult.ok ? (
                  <span className="text-xs text-success">✅ 通了 · 出口 IP <b className="font-mono">{testResult.exitIp}</b> · {testResult.latencyMs}ms</span>
                ) : (
                  <span className="text-xs text-danger">❌ {testResult.msg || "不通"}</span>
                )
              )}
            </div>
            {/* 建哪些协议:中转机被封才是常态、协议几乎不会被封,默认只建 VLESS 就够 */}
            <div className="space-y-1">
              <div className="text-sm">要建的协议(可多选)</div>
              <div className="flex flex-wrap gap-2">
                {PROTO_OPTIONS.map((o) => {
                  const cur: string[] = buildForm.protocols || [];
                  const on = cur.includes(o.value);
                  return (
                    <Button
                      key={o.value}
                      size="sm"
                      color={on ? "secondary" : "default"}
                      variant={on ? "solid" : "flat"}
                      onPress={() =>
                        setBuildForm({
                          ...buildForm,
                          protocols: on ? cur.filter((x) => x !== o.value) : [...cur, o.value],
                        })
                      }
                    >
                      {o.label}
                    </Button>
                  );
                })}
              </div>
              <div className="text-xs text-default-500">
                默认只建 VLESS-Reality:要防的是中转机被封,协议本身几乎不会被封,一个就够。多勾只是让客户订阅里多出几个同类节点。
              </div>
            </div>

            {/* Reality 借壳域名:建在前置机上的协议用,给个常用列表也允许自己输 */}
            <Autocomplete
              label="伪装域名(Reality 借壳)"
              allowsCustomValue
              defaultItems={SNI_PRESETS}
              inputValue={buildForm.sni}
              onInputChange={(v) => setBuildForm({ ...buildForm, sni: v })}
              onSelectionChange={(k) => { if (k) setBuildForm({ ...buildForm, sni: String(k) }); }}
              description="只影响前置机上 VLESS / Trojan 这两个 Reality 协议。可以直接输入别的域名;别用 www.microsoft.com(它上了后量子,握不上手)"
            >
              {(item: any) => <AutocompleteItem key={item.value} description={item.desc || undefined}>{item.label}</AutocompleteItem>}
            </Autocomplete>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={() => setBuildOpen(false)}>取消</Button>
            <Button color="secondary" isLoading={buildLoading} onPress={handleBuild}>保存并搭建</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}
