import { useState, useEffect } from "react";
import { Card, CardBody } from "@heroui/card";
import { Button } from "@heroui/button";
import { Input } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter } from "@heroui/modal";
import { Switch } from "@heroui/switch";
import { Chip } from "@heroui/chip";
import toast from "react-hot-toast";
import {
  getDnsAccounts,
  saveDnsAccount,
  deleteDnsAccount,
  getDnsZones,
  getDnsRecords,
  saveDnsRecord,
  deleteDnsRecord,
} from "@/api";
import type { DnsAccount, DnsZone, DnsRecord } from "@/api";

/** 记录类型:够日常用就行(节点域名、根域、CNAME 跳转、TXT 验证) */
const RECORD_TYPES = ["A", "AAAA", "CNAME", "TXT", "MX", "NS"];

/** TTL:1 = 自动(橙云记录只认自动) */
const TTL_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: "自动" },
  { value: 60, label: "1 分钟" },
  { value: 300, label: "5 分钟" },
  { value: 600, label: "10 分钟" },
  { value: 1800, label: "30 分钟" },
  { value: 3600, label: "1 小时" },
  { value: 86400, label: "1 天" },
];

interface RecordForm {
  id: string | null;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
}

const EMPTY_RECORD: RecordForm = { id: null, type: "A", name: "", content: "", ttl: 1, proxied: false };

/** 只有 A / AAAA / CNAME 能开橙云;给 TXT 塞 proxied 会被 Cloudflare 直接拒 */
const proxyable = (type: string) => type === "A" || type === "AAAA" || type === "CNAME";

const ttlText = (ttl?: number | null) => (!ttl || ttl === 1 ? "自动" : `${ttl}s`);

/**
 * DNS 管理:在面板里直接改 Cloudflare 的解析记录。
 *
 * 为什么放在面板里:给转发机配「连接域名」时,车主得专门开 Cloudflare 网页改 A 记录 ——
 * 换机器、换 IP 都要跑一趟,车友的订阅还等着生效。这里直连 Cloudflare API,
 * 改完立刻生效;转发机页还能一键把域名指到那台机器。
 *
 * token 只在保存账号时提交一次,后端加密入库,列表里只回掩码。
 */
export default function DnsPage() {
  const [accounts, setAccounts] = useState<DnsAccount[]>([]);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [zones, setZones] = useState<DnsZone[]>([]);
  const [zoneId, setZoneId] = useState<string>("");
  const [records, setRecords] = useState<DnsRecord[]>([]);
  const [loadingZones, setLoadingZones] = useState(false);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // 账号弹窗(新增 / 改名 / 换 token)
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountForm, setAccountForm] = useState<{ id: number | null; name: string; token: string }>({
    id: null,
    name: "",
    token: "",
  });
  const [accountSaving, setAccountSaving] = useState(false);

  // 记录弹窗(id 有值 = 编辑)
  const [recordOpen, setRecordOpen] = useState(false);
  const [recordForm, setRecordForm] = useState<RecordForm>(EMPTY_RECORD);
  const [recordSaving, setRecordSaving] = useState(false);

  const currentAccount = accounts.find((a) => a.id === accountId) || null;
  const currentZone = zones.find((z) => z.id === zoneId) || null;

  const loadAccounts = async (preferId?: number | null): Promise<number | null> => {
    try {
      const res = await getDnsAccounts();
      if (res.code !== 0) {
        toast.error(res.msg || "加载账号失败");
        return null;
      }
      const list = res.data || [];
      setAccounts(list);
      const next =
        preferId != null && list.some((a) => a.id === preferId) ? preferId : list.length ? list[0].id : null;
      setAccountId(next);
      return next;
    } catch (e) {
      toast.error("加载账号失败");
      return null;
    }
  };

  useEffect(() => {
    loadAccounts();
  }, []);

  // 账号变了 → 拉域名,默认选第一个
  useEffect(() => {
    if (!accountId) {
      setZones([]);
      setZoneId("");
      setRecords([]);
      return;
    }
    let alive = true;
    setLoadingZones(true);
    setRecords([]);
    setZoneId("");
    getDnsZones(accountId)
      .then((res) => {
        if (!alive) return;
        if (res.code === 0) {
          const list = res.data || [];
          setZones(list);
          setZoneId(list.length ? list[0].id : "");
        } else {
          setZones([]);
          toast.error(res.msg || "加载域名失败");
        }
      })
      .catch(() => {
        if (alive) {
          setZones([]);
          toast.error("加载域名失败");
        }
      })
      .finally(() => {
        if (alive) setLoadingZones(false);
      });
    return () => {
      alive = false;
    };
  }, [accountId]);

  // 域名变了 → 拉解析记录
  useEffect(() => {
    if (!accountId || !zoneId) {
      setRecords([]);
      return;
    }
    let alive = true;
    setLoadingRecords(true);
    getDnsRecords(accountId, zoneId)
      .then((res) => {
        if (!alive) return;
        if (res.code === 0) {
          setRecords(res.data || []);
        } else {
          setRecords([]);
          toast.error(res.msg || "加载解析记录失败");
        }
      })
      .catch(() => {
        if (alive) {
          setRecords([]);
          toast.error("加载解析记录失败");
        }
      })
      .finally(() => {
        if (alive) setLoadingRecords(false);
      });
    return () => {
      alive = false;
    };
  }, [accountId, zoneId]);

  const reloadRecords = async () => {
    if (!accountId || !zoneId) return;
    try {
      const res = await getDnsRecords(accountId, zoneId);
      if (res.code === 0) setRecords(res.data || []);
      else toast.error(res.msg || "加载解析记录失败");
    } catch (e) {
      toast.error("加载解析记录失败");
    }
  };

  // ===== 账号 =====
  const openAddAccount = () => {
    setAccountForm({ id: null, name: "", token: "" });
    setAccountOpen(true);
  };

  const openEditAccount = () => {
    if (!currentAccount) return;
    setAccountForm({ id: currentAccount.id, name: currentAccount.name, token: "" });
    setAccountOpen(true);
  };

  const handleAccountSave = async () => {
    const name = accountForm.name.trim();
    if (!name) {
      toast.error("给账号起个名字,方便区分");
      return;
    }
    if (accountForm.id == null && !accountForm.token.trim()) {
      toast.error("请填 Cloudflare API Token");
      return;
    }
    setAccountSaving(true);
    try {
      const res = await saveDnsAccount({ id: accountForm.id, name, token: accountForm.token.trim() });
      if (res.code === 0) {
        toast.success(accountForm.id == null ? "账号已保存" : "账号已更新");
        setAccountOpen(false);
        const saved = res.data as DnsAccount | null;
        await loadAccounts(saved?.id ?? accountForm.id);
      } else {
        // 无效 token 的报错就是 Cloudflare 的原话(一般是 Invalid API Token)
        toast.error(res.msg || "保存失败");
      }
    } catch (e) {
      toast.error("保存失败");
    } finally {
      setAccountSaving(false);
    }
  };

  const handleAccountDelete = async () => {
    if (!currentAccount) return;
    if (!window.confirm(`删除账号「${currentAccount.name}」?\n\n只是把 token 从面板里删掉,Cloudflare 上的解析记录不动。`)) return;
    try {
      const res = await deleteDnsAccount(currentAccount.id);
      if (res.code === 0) {
        toast.success("已删除账号");
        await loadAccounts(null);
      } else {
        toast.error(res.msg || "删除失败");
      }
    } catch (e) {
      toast.error("删除失败");
    }
  };

  // ===== 记录 =====
  const openAddRecord = () => {
    if (!zoneId) {
      toast.error("先选一个域名");
      return;
    }
    setRecordForm({ ...EMPTY_RECORD, name: currentZone ? currentZone.name : "" });
    setRecordOpen(true);
  };

  const openEditRecord = (r: DnsRecord) => {
    setRecordForm({
      id: r.id,
      type: r.type,
      name: r.name,
      content: r.content,
      ttl: r.ttl && r.ttl > 0 ? r.ttl : 1,
      proxied: !!r.proxied,
    });
    setRecordOpen(true);
  };

  const handleRecordSave = async () => {
    if (!accountId || !zoneId) {
      toast.error("先选账号和域名");
      return;
    }
    const name = recordForm.name.trim();
    const content = recordForm.content.trim();
    if (!name) {
      toast.error("请填记录名称;根域填 @ 或完整域名");
      return;
    }
    if (!content) {
      toast.error("请填记录内容");
      return;
    }
    setRecordSaving(true);
    try {
      const res = await saveDnsRecord({
        id: recordForm.id,
        accountId,
        zoneId,
        type: recordForm.type,
        name,
        content,
        ttl: recordForm.ttl,
        proxied: proxyable(recordForm.type) ? recordForm.proxied : false,
      });
      if (res.code === 0) {
        toast.success(res.msg || "已保存");
        setRecordOpen(false);
        reloadRecords();
      } else {
        // 橙云的限制(CNAME 到根域、TTL 不对)由 Cloudflare 决定,原话报给用户
        toast.error(res.msg || "保存失败");
      }
    } catch (e) {
      toast.error("保存失败");
    } finally {
      setRecordSaving(false);
    }
  };

  const handleRecordDelete = async (r: DnsRecord) => {
    if (!accountId || !zoneId) return;
    if (!window.confirm(`确定删除记录 ${r.type} ${r.name} → ${r.content} ?\n\n删除后解析立即失效,不可恢复。`)) return;
    try {
      const res = await deleteDnsRecord(accountId, zoneId, r.id);
      if (res.code === 0) {
        toast.success("记录已删除");
        reloadRecords();
      } else {
        toast.error(res.msg || "删除失败");
      }
    } catch (e) {
      toast.error("删除失败");
    }
  };

  /** 橙云开关:点了直接 PATCH;失败把开关拨回去再报错 */
  const handleToggleProxied = async (r: DnsRecord, next: boolean) => {
    if (!accountId || !zoneId) return;
    const before = !!r.proxied;
    setTogglingId(r.id);
    setRecords((prev) => prev.map((x) => (x.id === r.id ? { ...x, proxied: next } : x)));
    try {
      const res = await saveDnsRecord({
        id: r.id,
        accountId,
        zoneId,
        type: r.type,
        name: r.name,
        content: r.content,
        ttl: r.ttl && r.ttl > 0 ? r.ttl : 1,
        proxied: next,
      });
      if (res.code === 0) {
        toast.success(next ? "已开启橙云代理" : "已关闭橙云代理");
      } else {
        setRecords((prev) => prev.map((x) => (x.id === r.id ? { ...x, proxied: before } : x)));
        toast.error(res.msg || "修改失败");
      }
    } catch (e) {
      setRecords((prev) => prev.map((x) => (x.id === r.id ? { ...x, proxied: before } : x)));
      toast.error("修改失败");
    } finally {
      setTogglingId(null);
    }
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h1 className="text-xl font-bold">DNS 管理</h1>
        <div className="flex gap-2">
          {accounts.length > 0 && (
            <Button size="sm" variant="flat" onPress={openEditAccount} isDisabled={!currentAccount}>
              编辑账号
            </Button>
          )}
          {accounts.length > 0 && (
            <Button size="sm" variant="flat" color="danger" onPress={handleAccountDelete} isDisabled={!currentAccount}>
              删除账号
            </Button>
          )}
          <Button size="sm" color="primary" onPress={openAddAccount}>
            + 添加 Cloudflare 账号
          </Button>
        </div>
      </div>

      <div className="text-xs text-default-500">
        面板直连 Cloudflare 改解析记录。转发机的「连接域名」就在这里配:换机器时把 A 记录指到新 IP
        即可,车友的订阅和端口都不用动。
      </div>

      {accounts.length === 0 ? (
        <Card className="shadow-sm border border-default-200">
          <CardBody className="py-10 text-center space-y-3">
            <div className="text-sm text-default-600">
              还没有 Cloudflare 账号。添加一个 API Token 就能在这里管域名解析。
            </div>
            <div className="flex justify-center">
              <Button color="primary" onPress={openAddAccount}>
                添加 Cloudflare API Token
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : (
        <>
          {/* 账号 + 域名 */}
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-64">
              <Select
                label="Cloudflare 账号"
                size="sm"
                selectedKeys={accountId ? [String(accountId)] : []}
                onSelectionChange={(k) => {
                  const v = Array.from(k)[0];
                  setRecords([]);
                  setAccountId(v == null ? null : Number(v));
                }}
              >
                {accounts.map((a) => (
                  <SelectItem key={String(a.id)} textValue={a.name}>
                    {a.name}
                  </SelectItem>
                ))}
              </Select>
            </div>
            <div className="w-64">
              <Select
                label="域名"
                size="sm"
                placeholder={loadingZones ? "加载中..." : "选一个域名"}
                selectedKeys={zoneId ? [zoneId] : []}
                onSelectionChange={(k) => {
                  const v = Array.from(k)[0];
                  setZoneId(v == null ? "" : String(v));
                }}
              >
                {zones.map((z) => (
                  <SelectItem key={z.id} textValue={z.name}>
                    {z.name}
                  </SelectItem>
                ))}
              </Select>
            </div>
            <div className="flex-1" />
            <Button size="sm" color="primary" onPress={openAddRecord} isDisabled={!zoneId} className="mb-0.5">
              + 新增记录
            </Button>
          </div>

          <div className="text-xs text-default-400 flex items-center gap-2 flex-wrap">
            {currentAccount && (
              <span>
                当前账号 <b className="text-default-600">{currentAccount.name}</b> · Token{" "}
                <span className="font-mono">{currentAccount.tokenMask || "****"}</span>
              </span>
            )}
            {currentZone && <span>· 根域是 {currentZone.name}</span>}
          </div>

          {/* 解析记录表 */}
          {loadingRecords ? (
            <div className="py-10 text-center text-default-400 text-sm">正在加载解析记录...</div>
          ) : records.length === 0 ? (
            <div className="py-10 text-center text-default-400 text-sm">
              {zoneId ? "这个域名下还没有解析记录,点右上角「新增记录」。" : "先选一个域名。"}
            </div>
          ) : (
            <div className="rounded-xl border border-default-200 overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-default-100 text-xs text-default-600">
                    <th className="text-left font-medium px-3 py-2 whitespace-nowrap">类型</th>
                    <th className="text-left font-medium px-3 py-2 whitespace-nowrap">名称</th>
                    <th className="text-left font-medium px-3 py-2 whitespace-nowrap">内容</th>
                    <th className="text-left font-medium px-3 py-2 whitespace-nowrap">橙云</th>
                    <th className="text-left font-medium px-3 py-2 whitespace-nowrap">TTL</th>
                    <th className="text-right font-medium px-3 py-2 whitespace-nowrap">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((r, idx) => (
                    <tr key={r.id} className={"border-t border-default-100 " + (idx % 2 === 1 ? "bg-default-50" : "")}>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <Chip size="sm" variant="flat" color={proxyable(r.type) ? "primary" : "default"}>
                          {r.type}
                        </Chip>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">{r.name}</td>
                      <td className="px-3 py-2 font-mono text-xs max-w-[320px] truncate" title={r.content}>
                        {r.content}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {proxyable(r.type) ? (
                          <Switch
                            size="sm"
                            isSelected={!!r.proxied}
                            isDisabled={togglingId === r.id}
                            onValueChange={(v) => handleToggleProxied(r, v)}
                            aria-label="橙云代理"
                          />
                        ) : (
                          <span className="text-xs text-default-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-xs text-default-500">{ttlText(r.ttl)}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className="flex items-center justify-end gap-1">
                          <Button
                            size="sm"
                            variant="flat"
                            className="min-w-0 h-7 px-2 text-xs"
                            onPress={() => openEditRecord(r)}
                          >
                            编辑
                          </Button>
                          <Button
                            size="sm"
                            variant="flat"
                            color="danger"
                            className="min-w-0 h-7 px-2 text-xs"
                            onPress={() => handleRecordDelete(r)}
                          >
                            删除
                          </Button>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* 账号弹窗 */}
      <Modal isOpen={accountOpen} onClose={() => setAccountOpen(false)} size="lg">
        <ModalContent>
          <ModalHeader className="flex flex-col gap-1">
            {accountForm.id == null ? "添加 Cloudflare 账号" : "编辑 Cloudflare 账号"}
          </ModalHeader>
          <ModalBody className="space-y-3">
            <Input
              label="备注名"
              placeholder="如 主域名账号"
              value={accountForm.name}
              onChange={(e) => setAccountForm({ ...accountForm, name: e.target.value })}
            />
            <Input
              label="Cloudflare API Token"
              placeholder={accountForm.id == null ? "粘贴 API Token" : "留空 = 不改 token"}
              value={accountForm.token}
              onChange={(e) => setAccountForm({ ...accountForm, token: e.target.value })}
            />
            <div className="text-xs text-default-500 space-y-1 bg-default-100 rounded-lg px-3 py-2">
              <div>怎么拿 Token:Cloudflare 控制台 → 右上角头像 → My Profile → API Tokens → Create Token。</div>
              <div>
                权限选 <b>Zone → DNS → Edit</b>(改解析记录只需要这一个),Zone Resources 选要管的域名。
              </div>
              <div>保存时会先拿这个 Token 调一次「列域名」验证,无效会当场报错,不会存进去。</div>
              <div>Token 在面板里是加密存的,列表只回掩码,不会回明文。</div>
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={() => setAccountOpen(false)}>
              取消
            </Button>
            <Button color="primary" isLoading={accountSaving} onPress={handleAccountSave}>
              保存
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* 记录弹窗 */}
      <Modal isOpen={recordOpen} onClose={() => setRecordOpen(false)} size="lg">
        <ModalContent>
          <ModalHeader>{recordForm.id == null ? "新增解析记录" : "编辑解析记录"}</ModalHeader>
          <ModalBody className="space-y-3">
            <div className="flex gap-3">
              <div className="w-40">
                <Select
                  label="类型"
                  size="sm"
                  selectedKeys={[recordForm.type]}
                  onSelectionChange={(k) => {
                    const v = String(Array.from(k)[0] || "A");
                    setRecordForm({ ...recordForm, type: v });
                  }}
                >
                  {RECORD_TYPES.map((t) => (
                    <SelectItem key={t} textValue={t}>
                      {t}
                    </SelectItem>
                  ))}
                </Select>
              </div>
              <div className="flex-1">
                <Select
                  label="TTL"
                  size="sm"
                  selectedKeys={[String(recordForm.ttl)]}
                  onSelectionChange={(k) => setRecordForm({ ...recordForm, ttl: Number(Array.from(k)[0]) })}
                >
                  {TTL_OPTIONS.map((o) => (
                    <SelectItem key={String(o.value)} textValue={o.label}>
                      {o.label}
                    </SelectItem>
                  ))}
                </Select>
              </div>
            </div>
            <Input
              label="名称"
              placeholder="完整域名,如 hk.example.com;根域填 @"
              value={recordForm.name}
              onChange={(e) => setRecordForm({ ...recordForm, name: e.target.value })}
              description={currentZone ? `根域是 ${currentZone.name},"@" 表示它自己` : undefined}
            />
            <Input
              label="内容"
              placeholder={recordForm.type === "A" ? "如 1.2.3.4" : recordForm.type === "CNAME" ? "如 target.example.com" : "记录内容"}
              value={recordForm.content}
              onChange={(e) => setRecordForm({ ...recordForm, content: e.target.value })}
            />
            {proxyable(recordForm.type) ? (
              <div className="flex items-center justify-between rounded-lg border border-default-200 px-3 py-2">
                <div>
                  <div className="text-sm">橙云代理</div>
                  <div className="text-xs text-default-500">
                    开启后流量走 Cloudflare。节点端口(非 80/443)转发不通,节点的连接域名请关掉它。
                  </div>
                </div>
                <Switch
                  size="sm"
                  isSelected={recordForm.proxied}
                  onValueChange={(v) => setRecordForm({ ...recordForm, proxied: v })}
                  aria-label="橙云代理"
                />
              </div>
            ) : (
              <div className="text-xs text-default-400">{recordForm.type} 记录不支持橙云代理。</div>
            )}
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={() => setRecordOpen(false)}>
              取消
            </Button>
            <Button color="primary" isLoading={recordSaving} onPress={handleRecordSave}>
              保存
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}
