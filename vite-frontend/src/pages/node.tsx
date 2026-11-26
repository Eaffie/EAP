import { useState, useEffect, useRef, useMemo } from "react";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { Button } from "@heroui/button";
import { Input } from "@heroui/input";
import { Textarea } from "@heroui/input";
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter } from "@heroui/modal";
import { Chip } from "@heroui/chip";
import { Switch } from "@heroui/switch";
import { Autocomplete, AutocompleteItem } from "@heroui/autocomplete";
import { Select, SelectItem } from "@heroui/select";
import { Dropdown, DropdownTrigger, DropdownMenu, DropdownItem } from "@heroui/dropdown";
import { Spinner } from "@heroui/spinner";
import { Alert } from "@heroui/alert";
import { Progress } from "@heroui/progress";
import toast from 'react-hot-toast';
import { copyTextToClipboard } from "@/utils/clipboard";
import axios from 'axios';
import NodeMonitorModal from "@/components/node-monitor";

// 视图偏好(卡片 / 列表)存在浏览器里,下次进来还是上次选的那个;搜索词不存
const NODE_VIEW_KEY = 'eap:node-view';
const VIEW_CARD = 'card';
const VIEW_LIST = 'list';
type NodeView = typeof VIEW_CARD | typeof VIEW_LIST;


import {
  createNode,
  getNodeList,
  updateNode,
  enableNodeIpv6,
  disableNodeIpv6,
  deleteNode,
  getNodeInstallCommand,
  updateConfig,
  getInboundList,
  pushNodeConfig,
  getDnsAccounts,
  getDnsZones,
  pointDnsRecord
} from "@/api";

interface Node {
  id: number;
  name: string;
  ip: string;
  serverIp: string;
  domain?: string;
  /** 公网 IPv6(管理员填或节点上报后确认) */
  serverIpv6?: string;
  /** 订阅里出哪种线路:0 只 v4 / 1 v4 + v6 / 2 只 v6(v6 只在 ipv6Dual=1 时生效,否则只出 v4) */
  ipv6Sub?: number;
  /** 公网端口是否已改成 IPv4 和 IPv6 都收:0/1 */
  ipv6Dual?: number;
  /** 节点上报的公网 IPv6 */
  reportedIpv6?: string[];
  /** 节点程序是否支持切换监听(v14+);null = 离线或还没收到上报,不知道 */
  canSwitchListen?: boolean | null;
  ipv6Loading?: boolean;
  /** 该机 sing-box 是否在运行(节点上报);null/undefined = 还没上报过 */
  singboxRunning?: boolean;
  /** 该机装没装 sing-box。undefined = 老节点没上报这个字段,提示里两种情况都要提 */
  singboxInstalled?: boolean;
  /** 正在下载安装 sing-box(刚建完协议那一两分钟)。这时候不该报红 */
  singboxInstalling?: boolean;
  /** 上次安装失败的原因,有值就直接摆出来,省得上机器翻 journalctl */
  singboxInstallErr?: string;
  portSta: number;
  portEnd: number;
  version?: string;
  http?: number; // 0 关 1 开
  tls?: number;  // 0 关 1 开
  socks?: number; // 0 关 1 开
  status: number; // 1: 在线, 0: 离线
  connectionStatus: 'online' | 'offline';
  systemInfo?: {
    cpuUsage: number;
    memoryUsage: number;
    uploadTraffic: number;
    downloadTraffic: number;
    uploadSpeed: number;
    downloadSpeed: number;
    uptime: number;
  } | null;
  copyLoading?: boolean;
}

interface NodeForm {
  id: number | null;
  name: string;
  ipString: string;
  serverIp: string;
  domain: string;
  serverIpv6: string;
  ipv6Sub: number; // 0 只 v4 / 1 v4 + v6 / 2 只 v6
  portSta: number;
  portEnd: number;
  http: number; // 0 关 1 开
  tls: number;  // 0 关 1 开
  socks: number; // 0 关 1 开
}

export default function NodePage() {
  const [nodeList, setNodeList] = useState<Node[]>([]);
  // 建了协议的机器 id。没协议时 sing-box 本来就是停着的(agent 只预装、不启动,
  // 删光协议也会停掉它),不能报「未运行」。null = 没拿到协议列表,按老样子照报,免得藏住真故障
  const [monitorNode, setMonitorNode] = useState<any | null>(null);
  const [inboundNodeIds, setInboundNodeIds] = useState<Set<number> | null>(null);
  const [loading, setLoading] = useState(false);
  const [dialogVisible, setDialogVisible] = useState(false);
  const [dialogTitle, setDialogTitle] = useState('');
  const [isEdit, setIsEdit] = useState(false);
  const [submitLoading, setSubmitLoading] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [nodeToDelete, setNodeToDelete] = useState<Node | null>(null);
  // 开启 / 关闭 IPv6 的确认框
  const [ipv6Confirm, setIpv6Confirm] = useState<{ node: Node; enable: boolean } | null>(null);
  const [ipv6Errors, setIpv6Errors] = useState<{ title: string; items: string[] } | null>(null);
  const [protocolDisabled, setProtocolDisabled] = useState(false);
  const [protocolDisabledReason, setProtocolDisabledReason] = useState('');
  const [form, setForm] = useState<NodeForm>({
    id: null,
    name: '',
    ipString: '',
    serverIp: '',
    domain: '',
    serverIpv6: '',
    ipv6Sub: 0,
    portSta: 1000,
    portEnd: 65535,
    http: 0,
    tls: 0,
    socks: 0
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  // 卡片 / 列表视图(默认卡片)
  const [viewMode, setViewMode] = useState<NodeView>(() => {
    try {
      return localStorage.getItem(NODE_VIEW_KEY) === VIEW_LIST ? VIEW_LIST : VIEW_CARD;
    } catch {
      // localStorage 被禁(隐私模式)时按默认来
      return VIEW_CARD;
    }
  });
  // 搜索框:按机器名 / IP 实时过滤,不持久化
  const [search, setSearch] = useState('');

  // 「重推配置」按机器跑(整机恢复),存正在跑的那台机器 id
  const [repushing, setRepushing] = useState<number | null>(null);

  /**
   * 重推配置 = 整机恢复:重推这台机器的 sing-box 配置 + 重建它名下【全部】gost 转发服务。
   *
   * 为什么需要:换机器 / 机器重装之后,sing-box 那半有各种自动重推的时机(建删入站、改落地),
   * gost 那半却只在「转发被碰过」时才重建 —— 结果库里有转发、机器上一个公网口都没起来,
   * 面板上还没有任何入口能补。这台机器上所有线路、所有车友的转发都会一起重建,所以先确认一次。
   */
  const handleRepush = async (node: Node) => {
    if (!window.confirm(
      `重建「${node.name}」这台机器的配置?\n\n` +
      `· 重推 sing-box 配置\n` +
      `· 重建这台机器名下【全部】gost 转发服务(所有线路、所有车友)\n\n` +
      `重建期间这台机器上的端口会短暂中断;线路参数不变,只是把机器上跑的服务按库里重铺一遍。`
    )) return;

    setRepushing(node.id);
    try {
      const res = await pushNodeConfig(node.id);
      if (res.code === 0) {
        const okN = res.data?.forwardOk ?? res.data?.forwardTotal ?? 0;
        const badN = res.data?.forwardFail ?? 0;
        if (badN > 0) {
          toast(`已重推 ${okN} 条转发,${badN} 条失败(机器可能离线)`, { icon: '⚠️', duration: 8000 });
        } else {
          toast.success(`已重推 ${okN} 条转发`);
        }
      } else {
        toast.error(res.msg || '重推失败');
      }
    } catch (error) {
      toast.error('重推失败');
    } finally {
      setRepushing(null);
    }
  };

  // 安装命令相关状态
  const [installCommandModal, setInstallCommandModal] = useState(false);
  const [installCommand, setInstallCommand] = useState('');
  const [currentNodeName, setCurrentNodeName] = useState('');

  // 「指向这台机器」:把这台机器的连接域名在 Cloudflare 上的 A 记录指到它当前的 IP。
  // 换机器/换 IP 时不用再去 Cloudflare 网页上改,车友的订阅完全不用动。
  const [pointNode, setPointNode] = useState<Node | null>(null);
  const [pointAccounts, setPointAccounts] = useState<any[]>([]);
  const [pointZones, setPointZones] = useState<any[]>([]);
  const [pointAccountId, setPointAccountId] = useState<number | null>(null);
  const [pointDomain, setPointDomain] = useState('');
  const [pointLoading, setPointLoading] = useState(false);
  const [pointSaving, setPointSaving] = useState(false);

  // 这台机器当前用哪个 IP 对外:入口IP 取第一个(多 IP 时第一个才是主用),没填才退回服务器IP
  const nodePointIp = (node: Node | null): string => {
    if (!node) return '';
    return (node.ip || '').split(',')[0].trim() || (node.serverIp || '').trim();
  };

  const openPoint = async (node: Node) => {
    setPointNode(node);
    setPointDomain((node.domain || '').trim());
    setPointAccountId(null);
    setPointZones([]);
    setPointLoading(true);
    try {
      const res = await getDnsAccounts();
      if (res.code === 0) {
        const list = res.data || [];
        setPointAccounts(list);
        if (list.length) setPointAccountId(list[0].id);
      } else {
        setPointAccounts([]);
        toast.error(res.msg || '加载 Cloudflare 账号失败');
      }
    } catch (error) {
      setPointAccounts([]);
      toast.error('加载 Cloudflare 账号失败');
    } finally {
      setPointLoading(false);
    }
  };

  // 选了账号就把它下面的域名拉来,让用户直接选(也可以手输子域名)
  useEffect(() => {
    if (!pointNode || !pointAccountId) {
      setPointZones([]);
      return;
    }
    let alive = true;
    getDnsZones(pointAccountId)
      .then((res) => {
        if (alive && res.code === 0) setPointZones(res.data || []);
      })
      .catch(() => {
        // 拿不到域名不影响手输,静默即可
      });
    return () => {
      alive = false;
    };
  }, [pointNode, pointAccountId]);

  const handlePointSave = async () => {
    if (!pointNode) return;
    if (!pointAccountId) return toast.error('先选一个 Cloudflare 账号');
    const domain = pointDomain.trim();
    if (!domain || !domain.includes('.')) return toast.error('请填完整域名,如 hk.example.com');
    const ip = nodePointIp(pointNode);
    if (!ip) return toast.error('这台机器没填 IP,先去「编辑」里填服务器IP');
    setPointSaving(true);
    try {
      const res = await pointDnsRecord(pointAccountId, domain, ip);
      if (res.code === 0) {
        toast.success(res.msg || `已把 ${domain} 指向 ${ip}`);
        setPointNode(null);
      } else {
        toast.error(res.msg || '指向失败');
      }
    } catch (error) {
      toast.error('指向失败');
    } finally {
      setPointSaving(false);
    }
  };
  
  const websocketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const maxReconnectAttempts = 5;

  useEffect(() => {
    loadNodes();
    initWebSocket();
    
    return () => {
      closeWebSocket();
    };
  }, []);

  // 加载转发机列表
  const loadNodes = async () => {
    setLoading(true);
    getInboundList()
      .then((ib: any) => {
        if (ib.code === 0) {
          setInboundNodeIds(new Set((ib.data || []).map((x: any) => x.nodeId)));
        }
      })
      .catch(() => {});
    try {
      const res = await getNodeList();
      if (res.code === 0) {
        setNodeList(res.data.map((node: any) => ({
          ...node,
          connectionStatus: node.status === 1 ? 'online' : 'offline',
          systemInfo: null,
          copyLoading: false
        })));
      } else {
        toast.error(res.msg || '加载转发机列表失败');
      }
    } catch (error) {
      toast.error('网络错误，请重试');
    } finally {
      setLoading(false);
    }
  };

  // 初始化WebSocket连接
  const initWebSocket = () => {
    if (websocketRef.current && 
        (websocketRef.current.readyState === WebSocket.OPEN || 
         websocketRef.current.readyState === WebSocket.CONNECTING)) {
      return;
    }
    
    if (websocketRef.current) {
      closeWebSocket();
    }
    
    // 构建WebSocket URL，使用axios的baseURL
    const baseUrl = axios.defaults.baseURL || (import.meta.env.VITE_API_BASE ? `${import.meta.env.VITE_API_BASE}/api/v1/` : '/api/v1/');
    const wsUrl = baseUrl.replace(/^http/, 'ws').replace(/\/api\/v1\/$/, '') + `/system-info?type=0&secret=${localStorage.getItem('token')}`;
    
    try {
      websocketRef.current = new WebSocket(wsUrl);
      
      websocketRef.current.onopen = () => {
        reconnectAttemptsRef.current = 0;
      };
      
      websocketRef.current.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleWebSocketMessage(data);
        } catch (error) {
          // 解析失败时不输出错误信息
        }
      };
      
      websocketRef.current.onerror = () => {
        // WebSocket错误时不输出错误信息
      };
      
      websocketRef.current.onclose = () => {
        websocketRef.current = null;
        attemptReconnect();
      };
    } catch (error) {
      attemptReconnect();
    }
  };

  // 处理WebSocket消息
  const handleWebSocketMessage = (data: any) => {
    const { id, type, data: messageData } = data;
    
    if (type === 'status') {
      setNodeList(prev => prev.map(node => {
        if (node.id == id) {
          return {
            ...node,
            connectionStatus: messageData === 1 ? 'online' : 'offline',
            systemInfo: messageData === 0 ? null : node.systemInfo
          };
        }
        return node;
      }));
    } else if (type === 'info') {
      setNodeList(prev => prev.map(node => {
        if (node.id == id) {
          try {
            let systemInfo;
            if (typeof messageData === 'string') {
              systemInfo = JSON.parse(messageData);
            } else {
              systemInfo = messageData;
            }
            
            const currentUpload = parseInt(systemInfo.bytes_transmitted) || 0;
            const currentDownload = parseInt(systemInfo.bytes_received) || 0;
            const currentUptime = parseInt(systemInfo.uptime) || 0;
            
            let uploadSpeed = 0;
            let downloadSpeed = 0;
            
            if (node.systemInfo && node.systemInfo.uptime) {
              const timeDiff = currentUptime - node.systemInfo.uptime;
              
              if (timeDiff > 0 && timeDiff <= 10) {
                const lastUpload = node.systemInfo.uploadTraffic || 0;
                const lastDownload = node.systemInfo.downloadTraffic || 0;
                
                const uploadDiff = currentUpload - lastUpload;
                const downloadDiff = currentDownload - lastDownload;
                
                const uploadReset = currentUpload < lastUpload;
                const downloadReset = currentDownload < lastDownload;
                
                if (!uploadReset && uploadDiff >= 0) {
                  uploadSpeed = uploadDiff / timeDiff;
                }
                
                if (!downloadReset && downloadDiff >= 0) {
                  downloadSpeed = downloadDiff / timeDiff;
                }
              }
            }
            
            // 节点上报的公网 IPv6(系统信息里的 ipv6_addrs)。后端也会把第一个自动写进库里的
            // server_ipv6,但页面开着时这里直接跟着上报走,免得「有地址却一直显示没有」得手动刷新。
            // 老版本节点/没有公网 v6 时整个字段不带(omitempty),这时保持原值不动。
            const reportedV6: string[] | null = Array.isArray(systemInfo.ipv6_addrs)
              ? systemInfo.ipv6_addrs
                  .filter((x: any) => typeof x === 'string' && x.trim())
                  .map((x: string) => x.trim())
              : null;
            const v6Patch = reportedV6
              ? {
                  reportedIpv6: reportedV6,
                  // 库里已有地址(车主手填或之前自动填的)就不覆盖,和后端「只在空的时候填」一个口径
                  serverIpv6: (node.serverIpv6 || '').trim() || reportedV6[0] || node.serverIpv6,
                }
              : {};

            return {
              ...node,
              ...v6Patch,
              connectionStatus: 'online',
              // 节点在系统信息里顺带上报 sing-box 状态,这里实时更新
              singboxRunning: typeof systemInfo.singbox_running === 'boolean'
                ? systemInfo.singbox_running
                : node.singboxRunning,
              systemInfo: {
                cpuUsage: parseFloat(systemInfo.cpu_usage) || 0,
                memoryUsage: parseFloat(systemInfo.memory_usage) || 0,
                uploadTraffic: currentUpload,
                downloadTraffic: currentDownload,
                uploadSpeed: uploadSpeed,
                downloadSpeed: downloadSpeed,
                uptime: currentUptime
              }
            };
          } catch (error) {
            return node;
          }
        }
        return node;
      }));
    }
  };

  // 尝试重新连接
  const attemptReconnect = () => {
    if (reconnectAttemptsRef.current < maxReconnectAttempts) {
      reconnectAttemptsRef.current++;
      
      reconnectTimerRef.current = setTimeout(() => {
        initWebSocket();
      }, 3000 * reconnectAttemptsRef.current);
    }
  };

  // 关闭WebSocket连接
  const closeWebSocket = () => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    
    reconnectAttemptsRef.current = 0;
    
    if (websocketRef.current) {
      websocketRef.current.onopen = null;
      websocketRef.current.onmessage = null;
      websocketRef.current.onerror = null;
      websocketRef.current.onclose = null;
      
      if (websocketRef.current.readyState === WebSocket.OPEN || 
          websocketRef.current.readyState === WebSocket.CONNECTING) {
        websocketRef.current.close();
      }
      
      websocketRef.current = null;
    }
    
    setNodeList(prev => prev.map(node => ({
      ...node,
      connectionStatus: 'offline',
      systemInfo: null
    })));
  };


  
  // 格式化速度
  const formatSpeed = (bytesPerSecond: number): string => {
    if (bytesPerSecond === 0) return '0 B/s';
    
    const k = 1024;
    const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s'];
    const i = Math.floor(Math.log(bytesPerSecond) / Math.log(k));
    
    return parseFloat((bytesPerSecond / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  // 格式化流量
  const formatTraffic = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  // 获取进度条颜色
  const getProgressColor = (value: number, offline = false): "default" | "primary" | "secondary" | "success" | "warning" | "danger" => {
    if (offline) return "default";
    if (value <= 50) return "success";
    if (value <= 80) return "warning";
    return "danger";
  };

  // 卡片 / 列表上显示的主 IP:入口IP 取第一个(多 IP 时第一个才是主用),没填才退回服务器IP
  const nodeMainIp = (node: Node): string =>
    (node.ip || '').split(',')[0].trim() || (node.serverIp || '').trim() || '-';

  // 入口IP 除第一个外还有几个(多 IP 时标个 +N,信息不丢)
  const nodeIpExtra = (node: Node): number =>
    (node.ip || '').split(',').map(x => x.trim()).filter(Boolean).length - 1;

  // CPU / 内存:离线或还没上报系统信息就显示 -
  const usageValue = (node: Node, kind: 'cpu' | 'memory'): number => {
    if (node.connectionStatus !== 'online' || !node.systemInfo) return 0;
    return kind === 'cpu' ? node.systemInfo.cpuUsage : node.systemInfo.memoryUsage;
  };

  const usageText = (node: Node, kind: 'cpu' | 'memory'): string =>
    node.connectionStatus === 'online' && node.systemInfo ? `${usageValue(node, kind).toFixed(1)}%` : '-';

  // IPv6 小 Chip 上的悬浮说明:原来卡片里那一大块文字压进 title,信息不丢
  const ipv6Hint = (node: Node): string => {
    const on = node.ipv6Dual === 1;
    const sub = node.ipv6Sub === 2 ? '只出 IPv6' : node.ipv6Sub === 1 ? 'IPv4 + IPv6' : '只出 IPv4';
    const offTip = (node.ipv6Sub === 1 || node.ipv6Sub === 2) && (node.ipv6Dual !== 1 || !node.serverIpv6)
      ? (node.ipv6Dual !== 1 ? '(未开启 IPv6,暂时只出 IPv4)' : '(没有公网 IPv6 地址,暂时只出 IPv4)')
      : '';
    const hasV6 = node.ipv6Dual === 1 || !!node.serverIpv6 || (node.reportedIpv6 || []).length > 0;
    const lines = [
      on ? '已开启 IPv6:IPv4 和 IPv6 都收' : '未开启 IPv6:只收 IPv4',
      `公网 IPv6:${v6Addr(node) || '没有(未填,节点也没上报)'}`,
      `订阅里出:${sub}${offTip}(在「编辑」里改)`,
    ];
    // canSwitchListen:true/false = 节点上报过;null/undefined = 离线或面板刚重启还没收到上报,不能说「太旧」
    if (node.canSwitchListen === false) {
      lines.push(hasV6 ? '节点程序太旧,先升级节点程序(v14)' : '开关 IPv6 需节点程序 v14');
    } else if (node.canSwitchListen == null) {
      lines.push(node.connectionStatus === 'online' ? '等节点上报版本,稍后刷新页面' : (hasV6 ? '节点离线,上线后才能开关 IPv6' : '节点离线'));
    }
    return lines.join('\n');
  };

  // 搜索:机器名 / 入口IP / 服务器IP,大小写不敏感
  const filteredNodes = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return nodeList;
    return nodeList.filter(node =>
      (node.name || '').toLowerCase().includes(q) ||
      (node.ip || '').toLowerCase().includes(q) ||
      (node.serverIp || '').toLowerCase().includes(q)
    );
  }, [nodeList, search]);

  // 视图偏好落盘;存不了时(隐私模式)忽略,不影响用
  useEffect(() => {
    try {
      localStorage.setItem(NODE_VIEW_KEY, viewMode);
    } catch {
      // 忽略
    }
  }, [viewMode]);

  // 这台机器到底有没有 IPv6 地址(和「开没开双栈监听」是两回事):
  //   ① 库里存的 server_ipv6(车主手填,或节点上报后后端自动写进去的)
  //   ② 节点这次上报的公网 v6(reportedIpv6,不入库,面板刚重启还没落库时靠它兜底)
  // 两个都没有才算没有。Chip 上的 ●/○ 仍然只表示双栈开没开。
  const v6Addr = (node: Node): string =>
    (node.serverIpv6 || '').trim()
    || (node.reportedIpv6 || []).map(x => (x || '').trim()).find(Boolean)
    || '';

  // 卡片右上角小字:有地址就摆地址,没有就说「无」
  const v6Short = (node: Node): string => {
    const addr = v6Addr(node);
    if (!addr) return 'v6 无';
    return `v6 ${addr.length > 20 ? `${addr.slice(0, 20)}…` : addr}`;
  };

  // 列表里的「⋯」菜单分发:key → 原来那些 handler(handler 本身一个没改)
  const runRowAction = (key: string, node: Node) => {
    switch (key) {
      case 'monitor':
        setMonitorNode(node);
        break;
      case 'repush':
        handleRepush(node);
        break;
      case 'point':
        openPoint(node);
        break;
      case 'ipv6':
        setIpv6Confirm({ node, enable: node.ipv6Dual !== 1 });
        break;
      case 'delete':
        handleDelete(node);
        break;
      default:
        break;
    }
  };

  // 网速 / 流量渲染成「数字 + 单位」两段:数字右对齐、单位定宽,
  // 这样上传/下载/上行/下行四列的数字左端和单位左端都各成一条线,好一眼比大小
  const sizeCell = (text: string) => {
    const cut = text.lastIndexOf(' ');
    const num = cut < 0 ? text : text.slice(0, cut);
    const unit = cut < 0 ? '' : text.slice(cut + 1);
    return (
      <span className="inline-flex items-baseline justify-end">
        <span className="w-14 text-right font-mono tabular-nums text-xs">{num}</span>
        <span className="w-9 pl-1 text-left text-[11px] text-default-400">{unit}</span>
      </span>
    );
  };

  // 验证IP地址格式
  const validateIp = (ip: string): boolean => {
    if (!ip || !ip.trim()) return false;
    
    const trimmedIp = ip.trim();
    
    // IPv4格式验证
    const ipv4Regex = /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    
    // IPv6格式验证
    const ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
    
    if (ipv4Regex.test(trimmedIp) || ipv6Regex.test(trimmedIp) || trimmedIp === 'localhost') {
      return true;
    }
    
    // 验证域名格式
    if (/^\d+$/.test(trimmedIp)) return false;
    
    const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)+$/;
    const singleLabelDomain = /^[a-zA-Z][a-zA-Z0-9\-]{0,62}$/;
    
    return domainRegex.test(trimmedIp) || singleLabelDomain.test(trimmedIp);
  };

  // 表单验证
  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};
    
    if (!form.name.trim()) {
      newErrors.name = '请输入转发机名称';
    } else if (form.name.trim().length < 2) {
      newErrors.name = '转发机名称长度至少2位';
    } else if (form.name.trim().length > 50) {
      newErrors.name = '转发机名称长度不能超过50位';
    }
    
    if (!form.ipString.trim()) {
      newErrors.ipString = '请输入入口IP地址';
    } else {
      const ips = form.ipString.split('\n').map(ip => ip.trim()).filter(ip => ip);
      if (ips.length === 0) {
        newErrors.ipString = '请输入至少一个有效IP地址';
      } else {
        for (let i = 0; i < ips.length; i++) {
          if (!validateIp(ips[i])) {
            newErrors.ipString = `第${i + 1}行IP地址格式错误: ${ips[i]}`;
            break;
          }
        }
      }
    }
    
    if (!form.serverIp.trim()) {
      newErrors.serverIp = '请输入服务器IP地址';
    } else if (!validateIp(form.serverIp.trim())) {
      newErrors.serverIp = '请输入有效的IPv4、IPv6地址或域名';
    }

    // 连接域名是可选的:留空表示用 IP,填了才校验格式(且必须是域名,填 IP 没意义)
    const domain = form.domain.trim();
    if (domain) {
      if (/^[\d.]+$/.test(domain) || domain.includes(':') || domain.includes('/')) {
        newErrors.domain = '这里只填域名,别填 IP、端口或带 http://';
      } else if (!validateIp(domain)) {
        newErrors.domain = '域名格式不对,如 hk.example.com';
      }
    }

    const v6 = form.serverIpv6.trim();
    if (v6 && (!v6.includes(':') || !/^[0-9a-fA-F:]+$/.test(v6))) {
      newErrors.serverIpv6 = '这里只填 IPv6 地址,如 2001:db8::1,不带方括号和端口';
    }

    if (!form.portSta || form.portSta < 1 || form.portSta > 65535) {
      newErrors.portSta = '端口范围必须在1-65535之间';
    }
    
    if (!form.portEnd || form.portEnd < 1 || form.portEnd > 65535) {
      newErrors.portEnd = '端口范围必须在1-65535之间';
    } else if (form.portEnd < form.portSta) {
      newErrors.portEnd = '结束端口不能小于起始端口';
    }
    
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  // 新增转发机
  const handleAdd = () => {
    setDialogTitle('新增转发机');
    setIsEdit(false);
    setDialogVisible(true);
    resetForm();
    setProtocolDisabled(true);
    setProtocolDisabledReason('转发机未在线，等待转发机上线后再设置');
  };

  // 编辑转发机
  const handleEdit = (node: Node) => {
    setDialogTitle('编辑转发机');
    setIsEdit(true);
    setForm({
      id: node.id,
      name: node.name,
      ipString: node.ip ? node.ip.split(',').map(ip => ip.trim()).join('\n') : '',
      serverIp: node.serverIp || '',
      domain: node.domain || '',
      serverIpv6: node.serverIpv6 || '',
      ipv6Sub: node.ipv6Sub === 1 || node.ipv6Sub === 2 ? node.ipv6Sub : 0,
      portSta: node.portSta,
      portEnd: node.portEnd,
      http: typeof node.http === 'number' ? node.http : 1,
      tls: typeof node.tls === 'number' ? node.tls : 1,
      socks: typeof node.socks === 'number' ? node.socks : 1
    });
    const offline = node.connectionStatus !== 'online';
    setProtocolDisabled(offline);
    setProtocolDisabledReason(offline ? '转发机未在线，等待转发机上线后再设置' : '');
    setDialogVisible(true);
  };

  // 删除转发机
  const handleDelete = (node: Node) => {
    setNodeToDelete(node);
    setDeleteModalOpen(true);
  };

  const confirmDelete = async () => {
    if (!nodeToDelete) return;
    
    setDeleteLoading(true);
    try {
      const res = await deleteNode(nodeToDelete.id);
      if (res.code === 0) {
        toast.success('删除成功');
        setNodeList(prev => prev.filter(n => n.id !== nodeToDelete.id));
        setDeleteModalOpen(false);
        setNodeToDelete(null);
      } else {
        toast.error(res.msg || '删除失败');
      }
    } catch (error) {
      toast.error('网络错误，请重试');
    } finally {
      setDeleteLoading(false);
    }
  };

  // 兼容 http(非安全上下文)的复制:见 @/utils/clipboard
  const copyText = (text: string): Promise<boolean> => copyTextToClipboard(text);

  // 复制安装命令
  const handleCopyInstallCommand = async (node: Node) => {
    setNodeList(prev => prev.map(n => 
      n.id === node.id ? { ...n, copyLoading: true } : n
    ));
    
    try {
      let res = await getNodeInstallCommand(node.id);
      // 面板地址(网站配置的 ip)没设时,自动用当前访问域名 + 后端默认口 6365 填好再重试,
      // 免得用户手配或手打命令(手打易带 http:// 导致节点离线)
      if (res.code !== 0 && String(res.msg || "").includes("ip")) {
        await updateConfig("ip", `${window.location.hostname}:6365`);
        res = await getNodeInstallCommand(node.id);
      }
      if (res.code === 0 && res.data) {
        if (await copyText(res.data)) {
          toast.success('安装命令已复制到剪贴板');
        } else {
          // 复制失败，显示安装命令模态框让用户手动选择
          setInstallCommand(res.data);
          setCurrentNodeName(node.name);
          setInstallCommandModal(true);
        }
      } else {
        toast.error(res.msg || '获取安装命令失败');
      }
    } catch (error) {
      toast.error('获取安装命令失败');
    } finally {
      setNodeList(prev => prev.map(n => 
        n.id === node.id ? { ...n, copyLoading: false } : n
      ));
    }
  };

  // 手动复制安装命令
  const handleManualCopy = async () => {
    if (await copyText(installCommand)) {
      toast.success('安装命令已复制到剪贴板');
      setInstallCommandModal(false);
    } else {
      toast.error('复制失败，请手动选择文本复制');
    }
  };

  // 提交表单
  const handleSubmit = async () => {
    if (!validateForm()) return;
    
    setSubmitLoading(true);
    
    try {
      const ipString = form.ipString
        .split('\n')
        .map(ip => ip.trim())
        .filter(ip => ip)
        .join(',');
        
      // 校验时 trim 过,提交时也要 trim:粘贴带出的空格会进库,拼出的链接里多一个空格,客户端导不进去
      const serverIp = form.serverIp.trim();
      const submitData = {
        ...form,
        serverIp,
        domain: form.domain.trim(),
        serverIpv6: form.serverIpv6.trim(),
        ip: ipString
      };
      delete (submitData as any).ipString;
      
      const apiCall = isEdit ? updateNode : createNode;
      const data = isEdit ? submitData : { 
        name: form.name, 
        ip: ipString,
        serverIp,
        domain: form.domain.trim(),
        portSta: form.portSta,
        portEnd: form.portEnd,
        http: form.http,
        tls: form.tls,
        socks: form.socks
      };
      
      const res = await apiCall(data);
      if (res.code === 0) {
        toast.success(isEdit ? '更新成功' : '创建成功');
        setDialogVisible(false);
        
        if (isEdit) {
          setNodeList(prev => prev.map(n => 
            n.id === form.id ? {
              ...n,
              name: form.name,
              ip: ipString,
              serverIp,
              domain: form.domain.trim(),
              serverIpv6: form.serverIpv6.trim(),
              ipv6Sub: form.ipv6Sub,
              portSta: form.portSta,
              portEnd: form.portEnd,
              http: form.http,
              tls: form.tls,
              socks: form.socks
            } : n
          ));
        } else {
          loadNodes();
        }
      } else {
        toast.error(res.msg || (isEdit ? '更新失败' : '创建失败'));
      }
    } catch (error) {
      toast.error('网络错误，请重试');
    } finally {
      setSubmitLoading(false);
    }
  };

  // 后端失败时 data 里可能带逐条错误(字符串数组,或带 msg / error / name 的对象数组)
  const collectIpv6Errors = (res: any): string[] => {
    const d = res?.data;
    const list: any[] = Array.isArray(d) ? d : Array.isArray(d?.errors) ? d.errors : [];
    return list
      .map((x: any) => {
        if (typeof x === 'string') return x;
        if (x && typeof x === 'object') {
          const msg = x.msg || x.error || x.message || '';
          const who = x.name || x.tag || x.protocol || x.port || '';
          return who && msg ? `${who}:${msg}` : (msg || JSON.stringify(x));
        }
        return String(x);
      })
      .filter(Boolean);
  };

  // 后端失败时逐条原因写在 msg 里:「<总述>。失败的:a;b[。切回也失败了:c(原因);d(原因)]」
  const parseIpv6Msg = (msg: string): { title: string; items: string[] } => {
    const marker = '失败的:';
    const rbMarker = '切回也失败了:';
    const idx = msg.indexOf(marker);
    if (idx < 0) return { title: msg, items: [] };
    const title = msg.slice(0, idx).trim().replace(/。+$/, '');
    let rest = msg.slice(idx + marker.length);
    let rbPart = '';
    const rbIdx = rest.indexOf('。' + rbMarker);
    if (rbIdx >= 0) {
      rbPart = rest.slice(rbIdx + 1 + rbMarker.length);
      rest = rest.slice(0, rbIdx);
    }
    const split = (s: string) => s.split(';').map(x => x.trim()).filter(Boolean);
    return { title, items: [...split(rest), ...split(rbPart).map(x => `切回失败:${x}`)] };
  };

  const confirmIpv6Switch = async () => {
    if (!ipv6Confirm) return;
    const { node, enable } = ipv6Confirm;
    setIpv6Confirm(null);
    setNodeList(prev => prev.map(n => n.id === node.id ? { ...n, ipv6Loading: true } : n));
    try {
      const res: any = enable ? await enableNodeIpv6(node.id) : await disableNodeIpv6(node.id);
      if (res.code === 0) {
        toast.success(enable ? '已开启 IPv6' : '已关闭 IPv6');
        setNodeList(prev => prev.map(n => n.id === node.id ? { ...n, ipv6Dual: enable ? 1 : 0 } : n));
        // 节点上本来就没有服务的转发(老版本留下的失败转发):跳过了,列出来让车主知道
        const skipped: string[] = Array.isArray(res?.data?.skipped) ? res.data.skipped.filter((x: any) => typeof x === 'string') : [];
        if (skipped.length) {
          setIpv6Errors({ title: `${node.name}:${enable ? '已开启' : '已关闭'},有 ${skipped.length} 条转发没切(节点上本来就没有)`, items: skipped });
        }
      } else {
        const fallback = enable ? '开启 IPv6 失败' : '关闭 IPv6 失败';
        const msg: string = typeof res?.msg === 'string' ? res.msg : '';
        if (/timeout/i.test(msg) || msg.includes('网络请求失败')) {
          // 请求超时 / 网络错误:节点上可能已经切完,不能当失败
          toast.error('结果未知:可能已经切换完成,请刷新页面确认当前状态');
          loadNodes();
          return;
        }
        let items = collectIpv6Errors(res);
        let title = msg || fallback;
        if (!items.length && msg) {
          const parsed = parseIpv6Msg(msg);
          title = parsed.title || fallback;
          items = parsed.items;
        }
        toast.error(title);
        if (items.length) {
          setIpv6Errors({ title: `${node.name}:${title}`, items });
        }
      }
    } catch (error) {
      toast.error('网络错误,请刷新看一下当前状态');
    } finally {
      setNodeList(prev => prev.map(n => n.id === node.id ? { ...n, ipv6Loading: false } : n));
    }
  };

  // 重置表单
  const resetForm = () => {
    setForm({
      id: null,
      name: '',
      ipString: '',
      serverIp: '',
      domain: '',
      serverIpv6: '',
      ipv6Sub: 0,
      portSta: 1000,
      portEnd: 65535,
      http: 0,
      tls: 0,
      socks: 0
    });
    setErrors({});
  };

  return (
    
      <div className="px-3 lg:px-6 py-8">
        {/* 页面头部:标题 + 卡片/列表切换 + 搜索 + 新增 */}
        <div className="flex items-center justify-between gap-3 mb-6 flex-wrap">
          <h1 className="text-xl font-bold">转发机</h1>

          <div className="flex items-center gap-2 flex-wrap">
            {/* 视图切换:没装 @heroui/tabs,两个按钮拼一个分组就够了 */}
            <div className="flex items-center rounded-lg border border-default-200 overflow-hidden">
              <Button
                size="sm"
                variant={viewMode === VIEW_CARD ? 'solid' : 'light'}
                color={viewMode === VIEW_CARD ? 'primary' : 'default'}
                className="min-w-0 h-8 px-3 text-xs rounded-none"
                onPress={() => setViewMode(VIEW_CARD)}
              >
                卡片
              </Button>
              <Button
                size="sm"
                variant={viewMode === VIEW_LIST ? 'solid' : 'light'}
                color={viewMode === VIEW_LIST ? 'primary' : 'default'}
                className="min-w-0 h-8 px-3 text-xs rounded-none"
                onPress={() => setViewMode(VIEW_LIST)}
              >
                列表
              </Button>
            </div>

            {/* 按机器名 / IP 实时过滤(不持久化) */}
            <Input
              size="sm"
              aria-label="搜索转发机"
              placeholder="搜索机器名 / IP"
              className="w-48"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              isClearable
              onClear={() => setSearch('')}
            />

            <Button
              size="sm"
              variant="flat"
              color="primary"
              onPress={handleAdd}
            >
              新增
            </Button>
          </div>
        </div>

        {/* 转发机列表 */}
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="flex items-center gap-3">
              <Spinner size="sm" />
              <span className="text-default-600">正在加载...</span>
            </div>
          </div>
        ) : nodeList.length === 0 ? (
          <Card className="shadow-sm border border-gray-200 dark:border-gray-700">
            <CardBody className="text-center py-16">
              <div className="flex flex-col items-center gap-4">
                <div className="w-16 h-16 bg-default-100 rounded-full flex items-center justify-center">
                  <svg className="w-8 h-8 text-default-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 12h14M5 12l4-4m-4 4l4 4" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-foreground">暂无转发机配置</h3>
                  <p className="text-default-500 text-sm mt-1">还没有创建任何转发机配置，点击上方按钮开始创建</p>
                </div>
              </div>
            </CardBody>
          </Card>
        ) : filteredNodes.length === 0 ? (
          <div className="text-center text-default-400 py-16 text-sm">
            没有匹配的转发机(换个机器名或 IP 试试)
          </div>
        ) : viewMode === VIEW_LIST ? (
          /* 列表视图:一行一台机器。列和 relay.tsx 的表格一个样式(斑马纹 / border-t / whitespace-nowrap)。
             上传/下载/上行/下行拆成四列,数字右对齐 + 单位定宽,方便竖着一列比大小 */
          <div className="overflow-x-auto rounded-xl border border-default-200">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-default-50 text-xs text-default-600">
                  <th className="text-left font-medium px-3 py-2 whitespace-nowrap">状态</th>
                  <th className="text-left font-medium px-3 py-2 whitespace-nowrap">机器名</th>
                  <th className="text-left font-medium px-3 py-2 whitespace-nowrap">IP</th>
                  <th className="text-right font-medium px-3 py-2 whitespace-nowrap">CPU</th>
                  <th className="text-right font-medium px-3 py-2 whitespace-nowrap">内存</th>
                  <th className="text-right font-medium px-3 py-2 whitespace-nowrap">上传</th>
                  <th className="text-right font-medium px-3 py-2 whitespace-nowrap">下载</th>
                  <th className="text-right font-medium px-3 py-2 whitespace-nowrap">上行</th>
                  <th className="text-right font-medium px-3 py-2 whitespace-nowrap">下行</th>
                  <th className="text-left font-medium px-3 py-2 whitespace-nowrap">版本</th>
                  <th className="text-right font-medium px-3 py-2 whitespace-nowrap">操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredNodes.map((node, idx) => {
                  const online = node.connectionStatus === 'online';
                  const sys = online ? node.systemInfo : null;
                  const extraIp = nodeIpExtra(node);
                  return (
                    <tr
                      key={node.id}
                      className={"border-t border-default-100 " + (idx % 2 === 1 ? "bg-default-50" : "")}
                    >
                      <td className="px-3 py-2 whitespace-nowrap">
                        <Chip size="sm" variant="flat" color={online ? 'success' : 'danger'}>
                          {online ? '在线' : '离线'}
                        </Chip>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className="font-semibold">🖥 {node.name}</span>
                        {/* sing-box 挂了这里照样「在线」,单独标一下(「⋯」里有重推配置) */}
                        {online && node.singboxRunning === false
                          && (inboundNodeIds === null || inboundNodeIds.has(node.id)) && (
                          <span className="ml-2 text-[11px] text-danger" title="sing-box 没在跑,这台机上用 sing-box 的协议全部不可用">
                            ⚠️ sing-box
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap font-mono text-xs text-default-600" title={node.ip || ''}>
                        {nodeMainIp(node)}{extraIp > 0 ? ` +${extraIp}` : ''}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-right font-mono text-xs tabular-nums">{usageText(node, 'cpu')}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-right font-mono text-xs tabular-nums">{usageText(node, 'memory')}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-right">{sizeCell(sys ? formatSpeed(sys.uploadSpeed) : '-')}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-right">{sizeCell(sys ? formatSpeed(sys.downloadSpeed) : '-')}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-right">{sizeCell(sys ? formatTraffic(sys.uploadTraffic) : '-')}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-right">{sizeCell(sys ? formatTraffic(sys.downloadTraffic) : '-')}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-xs font-mono">{node.version || '未知'}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className="flex items-center justify-end gap-1">
                          {/* 用最多的两个直接摆出来,其余收进「⋯」 */}
                          <Button
                            size="sm"
                            variant="flat"
                            color="success"
                            className="min-w-0 h-7 px-2 text-xs"
                            isLoading={node.copyLoading}
                            onPress={() => handleCopyInstallCommand(node)}
                          >
                            安装命令
                          </Button>
                          <Button
                            size="sm"
                            variant="flat"
                            color="primary"
                            className="min-w-0 h-7 px-2 text-xs"
                            onPress={() => handleEdit(node)}
                          >
                            编辑
                          </Button>
                          {/* 其余动作:监控 / 重推配置 / 指向这台机器 / IPv6 / 删除。
                              用 HeroUI Dropdown(portal 渲染 + React Aria 定位/收起),
                              比自己写 fixed 面板稳:不会被表格的 overflow 裁掉,也不会被自己的
                              点击外部监听抢掉那次点击 */}
                          <Dropdown placement="bottom-end">
                            <DropdownTrigger>
                              <Button size="sm" variant="flat" className="min-w-0 h-7 px-2 text-xs" aria-label="更多操作">
                                ⋯
                              </Button>
                            </DropdownTrigger>
                            <DropdownMenu
                              aria-label={`${node.name} 的更多操作`}
                              onAction={(key) => runRowAction(String(key), node)}
                            >
                              <DropdownItem key="monitor" className="text-secondary">监控</DropdownItem>
                              <DropdownItem key="repush" className="text-warning">重推配置</DropdownItem>
                              <DropdownItem key="point" className="text-primary">指向这台机器</DropdownItem>
                              <DropdownItem
                                key="ipv6"
                                className={node.ipv6Dual === 1 ? 'text-warning' : 'text-primary'}
                                isDisabled={node.canSwitchListen === false}
                              >
                                {node.ipv6Dual === 1 ? '关闭 IPv6' : '开启 IPv6'}
                              </DropdownItem>
                              <DropdownItem key="delete" color="danger" className="text-danger">删除</DropdownItem>
                            </DropdownMenu>
                          </Dropdown>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 min-[1800px]:grid-cols-5 gap-3">
            {filteredNodes.map((node) => {
              const online = node.connectionStatus === 'online';
              const sys = online ? node.systemInfo : null;
              const v6on = node.ipv6Dual === 1;
              const extraIp = nodeIpExtra(node);
              return (
              <Card 
                key={node.id} 
                className="shadow-sm border border-divider hover:shadow-md transition-shadow duration-200"
              >
                <CardHeader className="pb-1 pt-3 px-3">
                  <div className="flex justify-between items-start w-full gap-2">
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-foreground truncate text-sm" title={node.name}>🖥 {node.name}</h3>
                      <p className="font-mono text-xs text-default-500 truncate" title={node.ip || ''}>
                        {nodeMainIp(node)}{extraIp > 0 ? ` +${extraIp}` : ''}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-0.5 shrink-0">
                      <div className="flex items-center gap-1">
                        <Chip 
                          color={node.connectionStatus === 'online' ? 'success' : 'danger'} 
                          variant="flat" 
                          size="sm"
                          className="text-xs"
                        >
                          {node.connectionStatus === 'online' ? '在线' : '离线'}
                        </Chip>
                        {/* IPv6 从原来的大方块降级成标题栏上的小 Chip;点了还是走原来那个确认框 */}
                        <Button
                          size="sm"
                          variant="flat"
                          color={v6on ? 'success' : 'default'}
                          className="min-w-0 min-h-6 h-6 px-2 text-[11px] gap-0.5"
                          isDisabled={node.canSwitchListen === false}
                          isLoading={node.ipv6Loading}
                          title={ipv6Hint(node)}
                          onPress={() => setIpv6Confirm({ node, enable: !v6on })}
                        >
                          IPv6<span className="text-[9px] leading-none">{v6on ? '●' : '○'}</span>
                        </Button>
                      </div>
                      {/* 有没有 IPv6 只按「有没有地址」显示:有就摆地址,没有就「v6 无」;
                          双栈开没开只看上面那个 Chip 的 ●/○ */}
                      <div
                        className="max-w-[11rem] min-w-0 truncate text-[10px] text-default-500"
                        title={v6Addr(node) || '这台机器没有公网 IPv6'}
                      >
                        {v6Short(node)}
                      </div>
                    </div>
                  </div>
                </CardHeader>

                <CardBody className="pt-0 pb-3 px-3">
                  {/* 「在线」只代表 gost 活着。sing-box 是另一个服务,它挂了这里照样绿,
                      但那台机上的协议全都用不了 —— 必须单独标出来 */}
                  {node.connectionStatus === 'online' && node.singboxRunning === false
                    && (inboundNodeIds === null || inboundNodeIds.has(node.id)) && (
                    node.singboxInstalling ? (
                      <div className="mb-3 rounded-lg border border-default-300 bg-default-100 px-2.5 py-2">
                        <div className="text-xs font-medium text-default-600">⏳ sing-box 安装中</div>
                        <div className="text-[11px] text-default-500 mt-0.5 leading-relaxed">
                          首次建协议时会现下约 57MB,一般 1-2 分钟,装好自动恢复。
                        </div>
                      </div>
                    ) : (
                      <div className="mb-3 rounded-lg border border-danger/40 bg-danger/10 px-2.5 py-2">
                        <div className="text-xs font-semibold text-danger">
                          ⚠️ sing-box {node.singboxInstallErr ? '安装失败' : '未运行'}
                        </div>
                        <div className="text-[11px] text-default-500 mt-0.5 leading-relaxed">
                          {node.singboxInstallErr ? (
                            <>这台机上的协议全部不可用。节点报的原因:<code className="font-mono break-all">{node.singboxInstallErr}</code>
                            。多半是下载 GitHub 失败,国内机改用镜像版命令重跑节点安装脚本。</>
                          ) : node.singboxInstalled === false ? (
                            <>这台机上的协议全部不可用。<span className="text-danger">sing-box 没装上</span>(装节点时下载 GitHub 失败,
                            国内机常见)—— 在这台机器上重跑一次节点安装脚本即可。</>
                          ) : (
                            <>这台机上的协议全部不可用。执行 <code className="font-mono">systemctl enable --now sing-box</code> 恢复;
                            若提示 unit 不存在,说明没装上,重跑节点安装脚本。</>
                          )}
                        </div>
                      </div>
                    )
                  )}
                  {/* CPU / 内存:标签 + 窄条(w-12)+ 百分比 三者贴在一起,两组之间 gap-6 拉开 */}
                  <div className="flex items-center gap-6 mb-2 text-xs">
                    <div className="flex items-center gap-1.5">
                      <span className="shrink-0 text-default-500">CPU</span>
                      <Progress
                        value={usageValue(node, 'cpu')}
                        color={getProgressColor(usageValue(node, 'cpu'), !online)}
                        size="sm"
                        aria-label="CPU使用率"
                        classNames={{ base: 'w-12 shrink-0', track: 'h-1.5' }}
                      />
                      <span className="w-12 shrink-0 text-right font-mono tabular-nums">{usageText(node, 'cpu')}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="shrink-0 text-default-500">内存</span>
                      <Progress
                        value={usageValue(node, 'memory')}
                        color={getProgressColor(usageValue(node, 'memory'), !online)}
                        size="sm"
                        aria-label="内存使用率"
                        classNames={{ base: 'w-12 shrink-0', track: 'h-1.5' }}
                      />
                      <span className="w-12 shrink-0 text-right font-mono tabular-nums">{usageText(node, 'memory')}</span>
                    </div>
                  </div>

                  {/* 上传 / 下载:一行小字(原来两块大方块) */}
                  <div className="flex items-center gap-3 text-xs mb-1">
                    <span className="font-mono tabular-nums text-default-600">
                      ↑ {sys ? formatSpeed(sys.uploadSpeed) : '-'}
                    </span>
                    <span className="font-mono tabular-nums text-default-600">
                      ↓ {sys ? formatSpeed(sys.downloadSpeed) : '-'}
                    </span>
                  </div>

                  {/* 上下行流量 + 版本:同一行小字,流量数字定宽右对齐(GB 列竖着对齐) */}
                  <div className="flex items-center justify-between gap-2 text-xs mb-2.5">
                    <span className="min-w-0 truncate">
                      <span className="text-default-500">上行</span>
                      <span className="ml-1 inline-block w-[4.5rem] text-right font-mono tabular-nums text-primary">
                        {sys ? formatTraffic(sys.uploadTraffic) : '-'}
                      </span>
                      <span className="ml-2 text-default-500">下行</span>
                      <span className="ml-1 inline-block w-[4.5rem] text-right font-mono tabular-nums text-success">
                        {sys ? formatTraffic(sys.downloadTraffic) : '-'}
                      </span>
                    </span>
                    <span className="shrink-0 text-default-500">
                      版本 <span className="font-mono">{node.version || '未知'}</span>
                    </span>
                  </div>

                  {/* 操作按钮:6 个动作固定两行三列(安装/编辑/监控 → 重推/指向/删除)。
                      按钮宽各自按两字文字自适应(w-fit 的网格),不撑满卡片 —— 卡片因此能变窄、一行多排一台 */}
                  <div className="grid w-fit grid-cols-3 gap-1.5">
                    <Button
                      size="sm"
                      variant="flat"
                      color="success"
                      title="安装命令"
                      onPress={() => handleCopyInstallCommand(node)}
                      isLoading={node.copyLoading}
                      className="min-h-7 h-7 px-2 text-xs"
                    >
                      安装
                    </Button>
                    <Button
                      size="sm"
                      variant="flat"
                      color="primary"
                      title="编辑"
                      onPress={() => handleEdit(node)}
                      className="min-h-7 h-7 px-2 text-xs"
                    >
                      编辑
                    </Button>
                    <Button
                      size="sm"
                      variant="flat"
                      color="secondary"
                      title="监控"
                      onPress={() => setMonitorNode(node)}
                      className="min-h-7 h-7 px-2 text-xs"
                    >
                      监控
                    </Button>
                    {/* 整机重推:这台机器名下所有线路的 sing-box + gost 服务一起按库里重铺,
                        换机器/机器重装后 gost 公网口全没了时用 */}
                    <Button
                      size="sm"
                      variant="flat"
                      color="warning"
                      title="重推配置"
                      onPress={() => handleRepush(node)}
                      isLoading={repushing === node.id}
                      className="min-h-7 h-7 px-2 text-xs"
                    >
                      重推
                    </Button>
                    {/* 换机器/换 IP 时,直接把「连接域名」的 A 记录指到这台机器,不用去 Cloudflare 网页改 */}
                    <Button
                      size="sm"
                      variant="flat"
                      color="primary"
                      title="指向这台机器"
                      onPress={() => openPoint(node)}
                      className="min-h-7 h-7 px-2 text-xs"
                    >
                      指向
                    </Button>
                    <Button
                      size="sm"
                      variant="flat"
                      color="danger"
                      title="删除"
                      onPress={() => handleDelete(node)}
                      className="min-h-7 h-7 px-2 text-xs"
                    >
                      删除
                    </Button>
                  </div>
                </CardBody>
              </Card>
              );
            })}
          </div>
        )}

        {/* 新增/编辑转发机对话框 */}
        <Modal 
          isOpen={dialogVisible} 
          onClose={() => setDialogVisible(false)}
          size="2xl"
          scrollBehavior="outside"
          backdrop="blur"
          placement="center"
        >
          <ModalContent>
            <ModalHeader>{dialogTitle}</ModalHeader>
            <ModalBody>
              <div className="space-y-4">
                <Input
                  label="转发机名称"
                  placeholder="请输入转发机名称"
                  value={form.name}
                  onChange={(e) => setForm(prev => ({ ...prev, name: e.target.value }))}
                  isInvalid={!!errors.name}
                  errorMessage={errors.name}
                  variant="bordered"
                />

                <Input
                  label="服务器IP"
                  placeholder="请输入服务器IP地址，如: 192.168.1.100 或 example.com"
                  value={form.serverIp}
                  onChange={(e) => setForm(prev => ({
                    ...prev,
                    serverIp: e.target.value,
                    // 入口IP 默认自动跟随服务器IP;用户手动改过入口IP后就不再覆盖
                    ipString: (!prev.ipString || prev.ipString === prev.serverIp) ? e.target.value : prev.ipString,
                  }))}
                  isInvalid={!!errors.serverIp}
                  errorMessage={errors.serverIp}
                  variant="bordered"
                />

                <Input
                  label="连接域名(可选)"
                  placeholder="如 hk.example.com,留空则给车友显示上面的 IP"
                  value={form.domain}
                  onChange={(e) => setForm(prev => ({ ...prev, domain: e.target.value }))}
                  isInvalid={!!errors.domain}
                  errorMessage={errors.domain}
                  variant="bordered"
                  description="填了之后,车友订阅里的节点地址显示成这个域名,看不到你的服务器 IP。需要先把域名解析(A 记录)到上面那个 IP。注意:域名只是不直接显示 IP,对方 ping 一下还是查得到"
                />

                {isEdit && (() => {
                  const editing = nodeList.find(n => n.id === form.id);
                  const reported = (editing?.reportedIpv6 || []).filter(Boolean);
                  const dual = editing?.ipv6Dual === 1;
                  return (
                    <>
                      <Input
                        label="公网 IPv6(可选)"
                        placeholder="如 2001:db8::1"
                        value={form.serverIpv6}
                        onChange={(e) => setForm(prev => ({ ...prev, serverIpv6: e.target.value }))}
                        isInvalid={!!errors.serverIpv6}
                        errorMessage={errors.serverIpv6}
                        variant="bordered"
                        description={`公网 IPv6,留空清除。节点上报的:${reported.length ? reported.join('、') : '没有(节点没上报公网 IPv6)'}`}
                      />
                      <div className="px-1">
                        <div className="text-sm">
                          <div>订阅里出哪种线路</div>
                          <div className="text-xs text-default-500 mt-0.5">
                            v6 线路名字后面都带「v6」;车友网络没有 IPv6 时 v6 线路连不上。
                            只有这台已开启 IPv6(卡片上的「开启 IPv6」)且填了公网 IPv6 时 v6 才生效
                            {dual ? '' : ',当前未开启,选了 v6 也暂时只出 IPv4'};「只出 IPv6」在 v6 用不了时自动退回只出 IPv4,订阅不会空。
                          </div>
                          {form.domain.trim() && (
                            <div className="text-xs text-warning-600 mt-0.5">
                              注意:填了连接域名,但 v6 线路用的是裸 IPv6 地址,车友能直接看到这台机器的 IPv6。
                            </div>
                          )}
                        </div>
                        <div className="flex gap-2 mt-2">
                          {[[0, '只出 IPv4'], [1, 'IPv4 + IPv6'], [2, '只出 IPv6']].map(([v, label]) => (
                            <Button
                              key={v as number}
                              size="sm"
                              variant={form.ipv6Sub === v ? 'solid' : 'flat'}
                              color={form.ipv6Sub === v ? 'primary' : 'default'}
                              onPress={() => setForm(prev => ({ ...prev, ipv6Sub: v as number }))}
                            >
                              {label as string}
                            </Button>
                          ))}
                        </div>
                      </div>
                    </>
                  );
                })()}

                <Textarea
                  label="入口IP"
                  placeholder="一行一个IP地址或域名，例如:&#10;192.168.1.100&#10;example.com"
                  value={form.ipString}
                  onChange={(e) => setForm(prev => ({ ...prev, ipString: e.target.value }))}
                  isInvalid={!!errors.ipString}
                  errorMessage={errors.ipString}
                  variant="bordered"
                  minRows={3}
                  maxRows={5}
                  description="默认自动和服务器IP一致，一般不用管；套CDN/域名/多IP时才改（支持多个，每行一个）"
                />

                <div className="grid grid-cols-2 gap-4">
                  <Input
                    label="起始端口"
                    type="number"
                    placeholder="1000"
                    value={form.portSta.toString()}
                    onChange={(e) => setForm(prev => ({ ...prev, portSta: parseInt(e.target.value) || 1000 }))}
                    isInvalid={!!errors.portSta}
                    errorMessage={errors.portSta}
                    variant="bordered"
                    min={1}
                    max={65535}
                  />

                  <Input
                    label="结束端口"
                    type="number"
                    placeholder="65535"
                    value={form.portEnd.toString()}
                    onChange={(e) => setForm(prev => ({ ...prev, portEnd: parseInt(e.target.value) || 65535 }))}
                    isInvalid={!!errors.portEnd}
                    errorMessage={errors.portEnd}
                    variant="bordered"
                    min={1}
                    max={65535}
                  />
                </div>

                {/* 屏蔽协议 */}
                <div className="mt-1">
                  <div className="text-sm font-medium text-default-700">屏蔽协议</div>
                  <div className="text-xs text-default-500 mb-2">开启开关以屏蔽对应协议</div>
                  {protocolDisabled && (
                    <Alert
                      color="warning"
                      variant="flat"
                      description={protocolDisabledReason || '等待转发机上线后再设置'}
                      className="mb-2"
                    />
                  )}
                  <div className={`grid grid-cols-1 sm:grid-cols-3 gap-3 bg-default-50 dark:bg-default-100 p-3 rounded-md border border-default-200 dark:border-default-100/30 ${protocolDisabled ? 'opacity-70' : ''}`}>
                    {/* HTTP tile */}
                    <div className="px-3 py-3 rounded-lg bg-white dark:bg-default-50 border border-default-200 dark:border-default-100/30 hover:border-primary-200 transition-colors">
                      <div className="flex items-center gap-2 mb-2">
                        <svg className="w-4 h-4 text-default-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 10h20"/></svg>
                        <div className="text-sm font-medium text-default-700">HTTP</div>
                      </div>
                      <div className="flex items-center justify-between">
                        <div className="text-xs text-default-500">禁用/启用</div>
                        <Switch
                          size="sm"
                          isSelected={form.http === 1}
                          isDisabled={protocolDisabled}
                          onValueChange={(v) => setForm(prev => ({ ...prev, http: v ? 1 : 0 }))}
                        />
                      </div>
                      <div className="mt-1 text-xs text-default-400">{form.http === 1 ? '已开启' : '已关闭'}</div>
                    </div>

                    {/* TLS tile */}
                    <div className="px-3 py-3 rounded-lg bg-white dark:bg-default-50 border border-default-200 dark:border-default-100/30 hover:border-primary-200 transition-colors">
                      <div className="flex items-center gap-2 mb-2">
                        <svg className="w-4 h-4 text-default-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 10V7a6 6 0 1 1 12 0v3"/><rect x="4" y="10" width="16" height="10" rx="2"/></svg>
                        <div className="text-sm font-medium text-default-700">TLS</div>
                      </div>
                      <div className="flex items-center justify-between">
                        <div className="text-xs text-default-500">禁用/启用</div>
                        <Switch
                          size="sm"
                          isSelected={form.tls === 1}
                          isDisabled={protocolDisabled}
                          onValueChange={(v) => setForm(prev => ({ ...prev, tls: v ? 1 : 0 }))}
                        />
                      </div>
                      <div className="mt-1 text-xs text-default-400">{form.tls === 1 ? '已开启' : '已关闭'}</div>
                    </div>

                    {/* SOCKS tile */}
                    <div className="px-3 py-3 rounded-lg bg-white dark:bg-default-50 border border-default-200 dark:border-default-100/30 hover:border-primary-200 transition-colors">
                      <div className="flex items-center gap-2 mb-2">
                        <svg className="w-4 h-4 text-default-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                        <div className="text-sm font-medium text-default-700">SOCKS</div>
                      </div>
                      <div className="flex items-center justify-between">
                        <div className="text-xs text-default-500">禁用/启用</div>
                        <Switch
                          size="sm"
                          isSelected={form.socks === 1}
                          isDisabled={protocolDisabled}
                          onValueChange={(v) => setForm(prev => ({ ...prev, socks: v ? 1 : 0 }))}
                        />
                      </div>
                      <div className="mt-1 text-xs text-default-400">{form.socks === 1 ? '已开启' : '已关闭'}</div>
                    </div>
                  </div>
                </div>



                <Alert
                        color="danger"
                        variant="flat"
                        description="请不要在出口转发机执行屏蔽协议，否则可能影响转发；屏蔽协议仅需在入口转发机执行。"
                        className="mt-3"
                      />
                
                <Alert
                        color="primary"
                        variant="flat"
                        description="服务器ip是你要添加的服务器的ip地址，不是面板的ip地址。入口ip是用于展示在转发页面，面向用户的访问地址。实在理解不到说明你没这个需求，都填转发机的服务器ip就行！"
                        className="mt-4"
                      />
              </div>
            </ModalBody>
            <ModalFooter>
              <Button
                variant="flat"
                onPress={() => setDialogVisible(false)}
              >
                取消
              </Button>
              <Button
                color="primary"
                onPress={handleSubmit}
                isLoading={submitLoading}
              >
                {submitLoading ? '提交中...' : '确定'}
              </Button>
            </ModalFooter>
          </ModalContent>
        </Modal>

        {/* 删除确认模态框 */}
        <Modal 
          isOpen={deleteModalOpen}
          onOpenChange={setDeleteModalOpen}
          size="2xl"
        scrollBehavior="outside"
        backdrop="blur"
        placement="center"
        >
          <ModalContent>
            {(onClose) => (
              <>
                <ModalHeader className="flex flex-col gap-1">
                  <h2 className="text-xl font-bold">确认删除</h2>
                </ModalHeader>
                <ModalBody>
                  <p>确定要删除转发机 <strong>"{nodeToDelete?.name}"</strong> 吗？</p>
                  <p className="text-small text-default-500">此操作不可恢复，请谨慎操作。</p>
                </ModalBody>
                <ModalFooter>
                  <Button variant="light" onPress={onClose}>
                    取消
                  </Button>
                  <Button 
                    color="danger" 
                    onPress={confirmDelete}
                    isLoading={deleteLoading}
                  >
                    {deleteLoading ? '删除中...' : '确认删除'}
                  </Button>
                </ModalFooter>
              </>
            )}
          </ModalContent>
        </Modal>

        <NodeMonitorModal node={monitorNode} onClose={() => setMonitorNode(null)} />

        {/* 「指向这台机器」:选账号 → 选/填域名(默认这台机器的连接域名)→ 把 A 记录指到它的 IP */}
        <Modal isOpen={!!pointNode} onClose={() => setPointNode(null)} size="lg">
          <ModalContent>
            <ModalHeader className="flex flex-col gap-1">
              <span>把域名指向「{pointNode?.name}」</span>
              <span className="text-sm font-normal text-default-500">
                目标 IP:<span className="font-mono">{nodePointIp(pointNode) || '这台机器没填 IP'}</span>
              </span>
            </ModalHeader>
            <ModalBody className="space-y-3">
              {pointLoading ? (
                <div className="text-sm text-default-500">正在加载 Cloudflare 账号...</div>
              ) : pointAccounts.length === 0 ? (
                <div className="text-sm text-default-500">
                  还没有 Cloudflare 账号。先去左侧菜单的「DNS」页添加一个 API Token(需要 Zone.DNS 编辑权限),
                  再回来一键指向。
                </div>
              ) : (
                <>
                  <Select
                    label="Cloudflare 账号"
                    placeholder="选一个账号"
                    selectedKeys={pointAccountId ? [String(pointAccountId)] : []}
                    onSelectionChange={(k) => {
                      const v = Array.from(k)[0];
                      setPointAccountId(v == null ? null : Number(v));
                    }}
                  >
                    {pointAccounts.map((a: any) => (
                      <SelectItem key={String(a.id)} textValue={a.name}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </Select>
                  <Autocomplete
                    label="域名"
                    allowsCustomValue
                    placeholder="hk.example.com"
                    defaultItems={pointZones.map((z: any) => ({ value: z.name, label: z.name }))}
                    inputValue={pointDomain}
                    onInputChange={setPointDomain}
                    onSelectionChange={(k) => {
                      if (k) setPointDomain(String(k));
                    }}
                    description={
                      pointNode?.domain
                        ? '默认是这台机器的「连接域名」;也可以选账号下的域名或手输子域名'
                        : '这台机器还没填「连接域名」,手动填要指向哪个域名'
                    }
                  >
                    {(item: any) => <AutocompleteItem key={item.value}>{item.label}</AutocompleteItem>}
                  </Autocomplete>
                  <div className="text-xs text-default-500 bg-default-100 rounded-lg px-3 py-2">
                    会把该域名的 <b>A 记录</b> 改成上面那个 IP:已经有这条记录就改内容,没有就新建一条。
                    橙云代理会自动关闭 —— 节点端口不在 Cloudflare 的代理端口里,开着它客户端连不上。
                  </div>
                </>
              )}
            </ModalBody>
            <ModalFooter>
              <Button variant="light" onPress={() => setPointNode(null)}>
                取消
              </Button>
              <Button
                color="primary"
                isDisabled={pointAccounts.length === 0}
                isLoading={pointSaving}
                onPress={handlePointSave}
              >
                确认指向
              </Button>
            </ModalFooter>
          </ModalContent>
        </Modal>

        {/* 开启 / 关闭 IPv6 确认 */}
        <Modal isOpen={!!ipv6Confirm} onClose={() => setIpv6Confirm(null)} size="md">
          <ModalContent>
            <ModalHeader>
              {ipv6Confirm?.enable ? '开启 IPv6' : '关闭 IPv6'}:{ipv6Confirm?.node.name}
            </ModalHeader>
            <ModalBody>
              <p className="text-sm">
                {ipv6Confirm?.enable
                  ? '会把这台转发机上协议用的公网端口改成 IPv4 和 IPv6 都收。正在用的 IPv4 连接不断;Hysteria2 / TUIC 这类 UDP 连接会重连一次。失败会自动尝试切回原样。'
                  : '会把这台转发机上协议用的公网端口改回只收 IPv4,通过 IPv6 连进来的车友会断开。正在用的 IPv4 连接不断;Hysteria2 / TUIC 这类 UDP 连接会重连一次。失败会自动尝试切回原样。'}
              </p>
            </ModalBody>
            <ModalFooter>
              <Button variant="light" onPress={() => setIpv6Confirm(null)}>取消</Button>
              <Button color={ipv6Confirm?.enable ? 'primary' : 'warning'} onPress={confirmIpv6Switch}>
                {ipv6Confirm?.enable ? '开启' : '关闭'}
              </Button>
            </ModalFooter>
          </ModalContent>
        </Modal>

        {/* IPv6 切换失败的逐条原因 */}
        <Modal isOpen={!!ipv6Errors} onClose={() => setIpv6Errors(null)} size="lg" scrollBehavior="inside">
          <ModalContent>
            <ModalHeader>{ipv6Errors?.title}</ModalHeader>
            <ModalBody>
              <ul className="text-sm space-y-1 list-disc pl-5">
                {ipv6Errors?.items.map((it, i) => <li key={i} className="break-all">{it}</li>)}
              </ul>
            </ModalBody>
            <ModalFooter>
              <Button onPress={() => setIpv6Errors(null)}>知道了</Button>
            </ModalFooter>
          </ModalContent>
        </Modal>

        {/* 安装命令模态框 */}
        <Modal 
          isOpen={installCommandModal} 
          onClose={() => setInstallCommandModal(false)}
          size="2xl"
        scrollBehavior="outside"
        backdrop="blur"
        placement="center"
        >
          <ModalContent>
            <ModalHeader>安装命令 - {currentNodeName}</ModalHeader>
            <ModalBody>
              <div className="space-y-4">
                <p className="text-sm text-default-600">
                  请复制以下安装命令到服务器上执行：
                </p>
                <div className="relative">
                  <Textarea
                    value={installCommand}
                    readOnly
                    variant="bordered"
                    minRows={6}
                    maxRows={10}
                    className="font-mono text-sm"
                    classNames={{
                      input: "font-mono text-sm"
                    }}
                  />
                  <Button
                    size="sm"
                    color="primary"
                    variant="flat"
                    className="absolute top-2 right-2"
                    onPress={handleManualCopy}
                  >
                    复制
                  </Button>
                </div>
                <div className="text-xs text-default-500">
                  💡 提示：如果复制按钮失效，请手动选择上方文本进行复制
                </div>
              </div>
            </ModalBody>
            <ModalFooter>
              <Button
                variant="flat"
                onPress={() => setInstallCommandModal(false)}
              >
                关闭
              </Button>
            </ModalFooter>
          </ModalContent>
        </Modal>
      </div>
    
  );
} 