import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from "@heroui/button";
import { Card, CardBody, CardHeader } from "@heroui/card";
import { Input } from "@heroui/input";
import { Spinner } from "@heroui/spinner";
import { Divider } from "@heroui/divider";
import { Switch } from "@heroui/switch";
import { Select, SelectItem } from "@heroui/select";
import { Modal, ModalContent, ModalHeader, ModalBody, ModalFooter } from "@heroui/modal";
import toast from 'react-hot-toast';
import {
  updateConfigs,
  getBackupList,
  exportBackup,
  downloadBackup,
  deleteBackup,
  importBackup,
} from '@/api';
import type { BackupFileInfo } from '@/api';
import { SettingsIcon } from '@/components/icons';

import { isAdmin } from '@/utils/auth';
import { getCachedConfigs, clearConfigCache, updateSiteConfig } from '@/config/site';

// 简单的保存图标组件
const SaveIcon = ({ className }: { className?: string }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
    <polyline points="17,21 17,13 7,13 7,21" />
    <polyline points="7,3 7,8 15,8" />
  </svg>
);

// 备份 / 恢复用小图标(和上面 SaveIcon 一个路数,不引图标库)
const BackupIcon = ({ className }: { className?: string }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7,10 12,15 17,10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

const RestoreIcon = ({ className }: { className?: string }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M21 12a9 9 0 1 1-3-6.7" />
    <polyline points="21,3 21,9 15,9" />
  </svg>
);

/** 备份文件多大:1024 进制 */
const formatBytes = (bytes: number) => {
  if (!bytes || bytes <= 0) return '0 KB';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
};

/** 时间戳 → 2026-11-26 12:00:00(浏览器本地时区) */
const formatTime = (ms: number) => {
  if (!ms) return '-';
  const d = new Date(ms);
  const p = (n: number) => (n < 10 ? '0' + n : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

interface ConfigItem {
  key: string;
  label: string;
  placeholder?: string;
  description?: string;
  type: 'input' | 'switch' | 'select';
  options?: { label: string; value: string; description?: string }[];
  dependsOn?: string; // 依赖的配置项key
  dependsValue?: string; // 依赖的配置项值
}

// 网站配置项定义
const CONFIG_ITEMS: ConfigItem[] = [
  {
    key: 'ip',
    label: '面板后端地址',
    placeholder: '请输入面板后端IP:PORT',
    description: '格式“ip:port”,用于对接转发机时使用,ip是你安装面板服务器的公网ip,端口是安装脚本内输入的后端端口。不要套CDN,不支持https,通讯数据有加密',
    type: 'input'
  },
  {
    key: 'sub_url',
    label: '订阅地址(给车友的)',
    placeholder: '不填 = 用面板网页地址;例如 https://sub.example.com',
    description: '填了之后,发给车友的订阅链接(复制、二维码)都用这个地址开头,车友拿到的订阅地址里看不到面板 IP。'
      + '一般用一个开了橙云(代理)的 Cloudflare 子域名,把订阅那两个路径转到面板后端端口(EAP 客户端「面板」页有分步说明,还能先实测再保存;在这里保存不做实测,填好后请先自己用订阅链接导入试一下)。'
      + '注意:面板机自己也当转发机 / 入口时,订阅内容里的节点地址就是面板 IP,藏不住;给车友开网页账号,网页地址就是面板地址;'
      + '同一个 IP 上别再挂灰色云朵(仅 DNS)的记录,例如面板自己的域名,否则等于告诉别人源 IP;'
      + 'Cloudflare 在国内一般能用、可能慢、偶尔不通;Cloudflare 到面板这一段是 http 明文(和现在一样)。'
      + '只填 http(s)://主机名[:端口][/路径前缀],不能带 ? 或 #。清空 = 回到用面板地址。',
    type: 'input'
  },
  {
    key: 'app_name',
    label: '应用名称',
    placeholder: '请输入应用名称',
    description: '在浏览器标签页和导航栏显示的应用名称',
    type: 'input'
  },
  {
    key: 'captcha_enabled',
    label: '启用验证码',
    description: '开启后，用户登录时需要完成验证码验证',
    type: 'switch'
  },
  {
    key: 'captcha_type',
    label: '验证码类型',
    description: '选择验证码的显示类型，不同类型有不同的安全级别',
    type: 'select',
    dependsOn: 'captcha_enabled',
    dependsValue: 'true',
    options: [
      { 
        label: '随机类型', 
        value: 'RANDOM', 
        description: '系统随机选择验证码类型' 
      },
      { 
        label: '滑块验证码', 
        value: 'SLIDER', 
        description: '拖动滑块完成拼图验证' 
      },
      { 
        label: '文字点选验证码', 
        value: 'WORD_IMAGE_CLICK', 
        description: '按顺序点击指定文字' 
      },
      { 
        label: '旋转验证码', 
        value: 'ROTATE', 
        description: '旋转图片到正确角度' 
      },
      { 
        label: '拼图验证码', 
        value: 'CONCAT', 
        description: '拖动滑块完成图片拼接' 
      }
    ]
  }
];

// 初始化时从缓存读取配置，避免闪烁
const getInitialConfigs = (): Record<string, string> => {
  if (typeof window === 'undefined') return {};
  
  const configKeys = ['app_name', 'captcha_enabled', 'captcha_type', 'ip', 'sub_url'];
  const initialConfigs: Record<string, string> = {};
  
  try {
    configKeys.forEach(key => {
      const cachedValue = localStorage.getItem('vite_config_' + key);
      if (cachedValue) {
        initialConfigs[key] = cachedValue;
      }
    });
  } catch (error) {
  }
  
  return initialConfigs;
};

export default function ConfigPage() {
  const navigate = useNavigate();
  const initialConfigs = getInitialConfigs();
  const [configs, setConfigs] = useState<Record<string, string>>(initialConfigs);
  const [loading, setLoading] = useState(Object.keys(initialConfigs).length === 0); // 如果有缓存数据，不显示loading
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [originalConfigs, setOriginalConfigs] = useState<Record<string, string>>(initialConfigs);

  // ===== 备份与恢复(这块跟上面的配置表单互不影响,单独存状态) =====
  const [backups, setBackups] = useState<BackupFileInfo[]>([]);
  const [backupLoading, setBackupLoading] = useState(true);
  // 正在下载的文件名(只用来给那一行的按钮转圈)
  const [backupBusy, setBackupBusy] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [includeMonitor, setIncludeMonitor] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoring, setRestoring] = useState(false);

  // 读备份文件列表
  const loadBackups = async () => {
    try {
      const res = await getBackupList();
      if (res.code === 0) {
        setBackups(res.data || []);
      } else {
        toast.error(res.msg || '读取备份列表失败');
      }
    } catch (error) {
      toast.error('读取备份列表失败');
    } finally {
      setBackupLoading(false);
    }
  };

  useEffect(() => {
    // 非管理员会被上面的权限检查带走,这里不用再拉接口
    if (!isAdmin()) {
      setBackupLoading(false);
      return;
    }
    loadBackups();
  }, []);

  // 权限检查
  useEffect(() => {
    if (!isAdmin()) {
      toast.error('权限不足，只有管理员可以访问此页面');
      navigate('/dashboard', { replace: true });
      return;
    }
  }, [navigate]);

  // 加载配置数据（优先从缓存）
  const loadConfigs = async (currentConfigs?: Record<string, string>) => {
    const configsToCompare = currentConfigs || configs;
    const hasInitialData = Object.keys(configsToCompare).length > 0;
    
    // 如果已有缓存数据，不显示loading，静默更新
    if (!hasInitialData) {
      setLoading(true);
    }
    
    try {
      const configData = await getCachedConfigs();
      
      // 只有在数据有变化时才更新
      const hasDataChanged = JSON.stringify(configData) !== JSON.stringify(configsToCompare);
      if (hasDataChanged) {
        setConfigs(configData);
        setOriginalConfigs({ ...configData });
        setHasChanges(false);
      } else {
      }
    } catch (error) {
      // 只有在没有缓存数据时才显示错误
      if (!hasInitialData) {
        toast.error('加载配置出错，请重试');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // 延迟加载，避免阻塞初始渲染
    const timer = setTimeout(() => {
      loadConfigs(initialConfigs);
    }, 100);

    return () => clearTimeout(timer);
  }, []); // 只在组件挂载时执行一次

  // 处理配置项变更
  const handleConfigChange = (key: string, value: string) => {
    let newConfigs = { ...configs, [key]: value };
    
    // 特殊处理：启用验证码时，如果验证码类型未设置，默认为随机
    if (key === 'captcha_enabled' && value === 'true') {
      if (!newConfigs.captcha_type) {
        newConfigs.captcha_type = 'RANDOM';
      }
    }
    
    setConfigs(newConfigs);
    
    // 检查是否有变更
    const hasChangesNow = Object.keys(newConfigs).some(
      k => newConfigs[k] !== originalConfigs[k]
    ) || Object.keys(originalConfigs).some(
      k => originalConfigs[k] !== newConfigs[k]
    );
    setHasChanges(hasChangesNow);
  };

  // 保存配置
  const handleSave = async () => {
    setSaving(true);
    try {
      const response = await updateConfigs(configs);
      if (response.code === 0) {
        toast.success('配置保存成功');
        
        // 清除所有配置缓存，强制下次重新获取
        clearConfigCache();
        
        // 获取变更的配置项
        const changedKeys = Object.keys(configs).filter(
          key => configs[key] !== originalConfigs[key]
        );
        
        // 订阅地址后端存的是规范化后的值(去首尾空白、去末尾 /,和 SubUrlRule.normalize 一致),输入框跟着显示存进去的样子
        const saved = { ...configs };
        if (typeof saved.sub_url === 'string') {
          saved.sub_url = saved.sub_url.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '').replace(/\/+$/, '');
          setConfigs(saved);
        }
        setOriginalConfigs(saved);
        setHasChanges(false);
        
        // 如果应用名称发生变化，立即更新网站配置
        if (changedKeys.includes('app_name')) {
          await updateSiteConfig();
        }
        
        // 触发配置更新事件，通知其他组件
        window.dispatchEvent(new CustomEvent('configUpdated', { 
          detail: { changedKeys } 
        }));
      } else {
        toast.error('保存配置失败: ' + response.msg);
      }
    } catch (error) {
      toast.error('保存配置出错，请重试');
    } finally {
      setSaving(false);
    }
  };



  // ===== 备份与恢复的操作 =====

  /** 把 blob 交给浏览器下载(token 在 header 里,不能直接 window.open) */
  const saveBlobAsFile = (blob: Blob, filename: string) => {
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  };

  const handleDownloadBackup = async (name: string) => {
    setBackupBusy(name);
    try {
      const res = await downloadBackup(name);
      if (!res.ok || !res.blob) {
        toast.error(res.msg || '下载失败');
        return;
      }
      saveBlobAsFile(res.blob, res.filename || name);
    } catch (error) {
      toast.error('下载失败');
    } finally {
      setBackupBusy(null);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const res = await exportBackup(includeMonitor);
      if (res.code !== 0) {
        toast.error(res.msg || '备份失败');
        return;
      }
      toast.success(res.msg || '备份完成');
      setExportOpen(false);
      await loadBackups();
      // 刚生成的这份顺手下载,省一次点击
      if (res.data && res.data.fileName) {
        await handleDownloadBackup(res.data.fileName);
      }
    } catch (error) {
      toast.error('备份失败');
    } finally {
      setExporting(false);
    }
  };

  const handleDeleteBackup = async (name: string) => {
    if (!window.confirm(`删除备份 ${name}?\n\n只删这一个文件,不影响面板里的数据。`)) {
      return;
    }
    try {
      const res = await deleteBackup(name);
      if (res.code === 0) {
        toast.success('已删除');
        await loadBackups();
      } else {
        toast.error(res.msg || '删除失败');
      }
    } catch (error) {
      toast.error('删除失败');
    }
  };

  /** 选文件:后缀/大小先在浏览器这边拦一道,后端还会再校验一次 */
  const pickRestoreFile = (file: File | null) => {
    if (!file) {
      setRestoreFile(null);
      return;
    }
    if (!file.name.toLowerCase().endsWith('.sql')) {
      toast.error('只支持 .sql 备份文件');
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      toast.error('文件超过 50MB 上限');
      return;
    }
    setRestoreFile(file);
  };

  const handleRestore = async () => {
    if (!restoreFile) {
      toast.error('请先选 .sql 备份文件');
      return;
    }
    const confirmed = window.confirm(
      `用 ${restoreFile.name} 恢复?\n\n`
      + '会覆盖当前库里的所有数据(用户、线路、转发、节点、网站配置全部换成备份里的)。\n'
      + '执行前会自动把当前库备份成 before_restore_*.sql,恢复错了还能退回去。'
    );
    if (!confirmed) return;

    setRestoring(true);
    try {
      const res = await importBackup(restoreFile);
      if (res.code === 0) {
        toast.success(res.msg || '恢复完成');
        setRestoreOpen(false);
        setRestoreFile(null);
        await loadBackups();
      } else {
        toast.error(res.msg || '恢复失败');
      }
    } catch (error) {
      toast.error('恢复失败');
    } finally {
      setRestoring(false);
    }
  };

  // 检查配置项是否应该显示（依赖检查）
  const shouldShowItem = (item: ConfigItem): boolean => {
    if (!item.dependsOn || !item.dependsValue) {
      return true;
    }
    return configs[item.dependsOn] === item.dependsValue;
  };

  // 渲染不同类型的配置项
  const renderConfigItem = (item: ConfigItem) => {
    const isChanged = hasChanges && configs[item.key] !== originalConfigs[item.key];
    
    switch (item.type) {
      case 'input':
        return (
          <Input
            value={configs[item.key] || ''}
            onChange={(e) => handleConfigChange(item.key, e.target.value)}
            placeholder={item.placeholder}
            variant="bordered"
            size="md"
            classNames={{
              input: "text-sm",
              inputWrapper: isChanged 
                ? "border-warning-300 data-[hover=true]:border-warning-400" 
                : ""
            }}
          />
        );

      case 'switch':
        return (
          <Switch
            isSelected={configs[item.key] === 'true'}
            onValueChange={(checked) => handleConfigChange(item.key, checked ? 'true' : 'false')}
            color="primary"
            size="md"
            classNames={{
              wrapper: isChanged ? "border-warning-300" : ""
            }}
          >
            <span className="text-sm text-gray-700 dark:text-gray-300">
              {configs[item.key] === 'true' ? '已启用' : '已禁用'}
            </span>
          </Switch>
        );

      case 'select':
        return (
          <Select
            selectedKeys={configs[item.key] ? [configs[item.key]] : []}
            onSelectionChange={(keys) => {
              const selectedKey = Array.from(keys)[0] as string;
              if (selectedKey) {
                handleConfigChange(item.key, selectedKey);
              }
            }}
            placeholder="请选择验证码类型"
            variant="bordered"
            size="md"
            classNames={{
              trigger: isChanged 
                ? "border-warning-300 data-[hover=true]:border-warning-400" 
                : ""
            }}
          >
            {item.options?.map((option) => (
              <SelectItem 
                key={option.value}
                description={option.description}
              >
                {option.label}
              </SelectItem>
            )) || []}
          </Select>
        );

      default:
        return null;
    }
  };

  if (loading) {
    return (
      
        <div className="flex items-center justify-center min-h-[400px]">
          <Spinner size="lg" label="加载配置中..." />
        </div>
      
    );
  }

  return (
    
      <div className="p-6 max-w-4xl mx-auto">
        {/* 页面标题 */}
        <div className="flex items-center gap-3 mb-6">
          <SettingsIcon className="w-8 h-8 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">网站配置</h1>
            <p className="text-gray-600 dark:text-gray-400">
              管理网站的基本信息和显示设置
            </p>
          </div>
        </div>

        <Card className="shadow-md">
          <CardHeader className="pb-4">
            <div className="flex justify-between items-center w-full">
              <div>
                <h2 className="text-xl font-semibold">基本设置</h2>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  配置网站的基本信息，这些设置会影响网站的显示效果
                </p>
              </div>
              <div className="flex gap-2">

                <Button
                  color="primary"
                  startContent={<SaveIcon className="w-4 h-4" />}
                  onClick={handleSave}
                  isLoading={saving}
                  disabled={!hasChanges}
                >
                  {saving ? '保存中...' : '保存配置'}
                </Button>
              </div>
            </div>
          </CardHeader>

          <Divider />

          <CardBody className="space-y-6 pt-6">
            {CONFIG_ITEMS.map((item, index) => {
              // 检查配置项是否应该显示
              if (!shouldShowItem(item)) {
                return null;
              }

              // 计算是否是最后一个显示的项目（用于决定是否显示分隔线）
              const remainingItems = CONFIG_ITEMS.slice(index + 1).filter(shouldShowItem);
              const isLastItem = remainingItems.length === 0;

              return (
                <div key={item.key} className="space-y-3">
                  <div className="flex flex-col gap-1">
                    <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                      {item.label}
                    </label>
                    {item.description && (
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {item.description}
                      </p>
                    )}
                  </div>
                  
                  {/* 渲染配置项 */}
                  {renderConfigItem(item)}
                  
                  {/* 分隔线 */}
                  {!isLastItem && (
                    <Divider className="mt-6" />
                  )}
                </div>
              );
            })}
          </CardBody>
        </Card>

        {/* 操作提示 */}
        {hasChanges && (
          <Card className="mt-4 bg-warning-50 dark:bg-warning-900/20 border-warning-200 dark:border-warning-800">
            <CardBody className="py-3">
              <div className="flex items-center gap-2 text-warning-700 dark:text-warning-300">
                <div className="w-2 h-2 bg-warning-500 rounded-full animate-pulse" />
                <span className="text-sm">
                  检测到配置变更，请记得保存您的修改
                </span>
              </div>
            </CardBody>
          </Card>
        )}
        {/* 备份与恢复:换面板机时不用 SSH 传文件,网页里导出/下载/上传恢复 */}
        <Card className="shadow-md mt-6">
          <CardHeader className="pb-4">
            <div className="flex justify-between items-center w-full gap-3 flex-wrap">
              <div>
                <h2 className="text-xl font-semibold">备份与恢复</h2>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  把数据库导成 .sql 下载到本地;新面板上传同一个文件就能恢复。换机器不用再 SSH 传文件。
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  color="primary"
                  startContent={<BackupIcon className="w-4 h-4" />}
                  onClick={() => setExportOpen(true)}
                >
                  立即备份
                </Button>
                <Button
                  variant="bordered"
                  startContent={<RestoreIcon className="w-4 h-4" />}
                  onClick={() => {
                    setRestoreFile(null);
                    setRestoreOpen(true);
                  }}
                >
                  上传恢复
                </Button>
              </div>
            </div>
          </CardHeader>

          <Divider />

          <CardBody className="space-y-3 pt-6">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <p className="text-xs text-gray-500 dark:text-gray-400">
                备份文件存在面板后端容器的 /app/logs/backups/ 里(已有卷),只保留最近 20 份。
              </p>
              <Button size="sm" variant="light" onClick={loadBackups} isLoading={backupLoading}>
                刷新
              </Button>
            </div>

            {backupLoading ? (
              <div className="py-8 text-center text-sm text-gray-400">正在读取备份列表...</div>
            ) : backups.length === 0 ? (
              <div className="py-8 text-center text-sm text-gray-400">
                还没有备份文件,点右上角「立即备份」生成一份。
              </div>
            ) : (
              <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="bg-gray-100 dark:bg-gray-800 text-xs text-gray-600 dark:text-gray-300">
                      <th className="text-left font-medium px-3 py-2 whitespace-nowrap">文件名</th>
                      <th className="text-left font-medium px-3 py-2 whitespace-nowrap">大小</th>
                      <th className="text-left font-medium px-3 py-2 whitespace-nowrap">时间</th>
                      <th className="text-right font-medium px-3 py-2 whitespace-nowrap">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {backups.map((file, index) => (
                      <tr
                        key={file.name}
                        className={
                          'border-t border-gray-100 dark:border-gray-800 ' +
                          (index % 2 === 1 ? 'bg-gray-50 dark:bg-gray-900/40' : '')
                        }
                      >
                        <td className="px-3 py-2 font-mono text-xs break-all">{file.name}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-500 dark:text-gray-400">
                          {formatBytes(file.size)}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-500 dark:text-gray-400">
                          {formatTime(file.createdTime)}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span className="flex items-center justify-end gap-1">
                            <Button
                              size="sm"
                              variant="flat"
                              className="min-w-0 h-7 px-2 text-xs"
                              isLoading={backupBusy === file.name}
                              onClick={() => handleDownloadBackup(file.name)}
                            >
                              下载
                            </Button>
                            <Button
                              size="sm"
                              variant="flat"
                              color="danger"
                              className="min-w-0 h-7 px-2 text-xs"
                              onClick={() => handleDeleteBackup(file.name)}
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
          </CardBody>
        </Card>

        {/* 立即备份 */}
        <Modal isOpen={exportOpen} onClose={() => setExportOpen(false)} size="md">
          <ModalContent>
            <ModalHeader className="flex flex-col gap-1">立即备份</ModalHeader>
            <ModalBody className="space-y-4">
              <div className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2">
                <div>
                  <div className="text-sm">包含监控历史</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    转发机的流量 / 探针曲线(约 4MB、3 万多行)。换机器用不上,默认不带。
                  </div>
                </div>
                <Switch
                  isSelected={includeMonitor}
                  onValueChange={setIncludeMonitor}
                  size="sm"
                  aria-label="包含监控历史"
                />
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                业务数据很小,一般几秒就好。生成后会自动开始下载,并只保留最近 20 份备份。
              </p>
            </ModalBody>
            <ModalFooter>
              <Button variant="light" onClick={() => setExportOpen(false)}>
                取消
              </Button>
              <Button color="primary" isLoading={exporting} onClick={handleExport}>
                开始备份
              </Button>
            </ModalFooter>
          </ModalContent>
        </Modal>

        {/* 上传恢复 */}
        <Modal isOpen={restoreOpen} onClose={() => setRestoreOpen(false)} size="lg" isDismissable={!restoring}>
          <ModalContent>
            <ModalHeader className="flex flex-col gap-1">上传备份恢复</ModalHeader>
            <ModalBody className="space-y-4">
              <div>
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300">选择 .sql 备份文件</label>
                <input
                  type="file"
                  accept=".sql"
                  disabled={restoring}
                  onChange={(e) => pickRestoreFile(e.target.files && e.target.files[0] ? e.target.files[0] : null)}
                  className="mt-2 block w-full text-sm text-gray-600 dark:text-gray-300 cursor-pointer
                    file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0
                    file:text-sm file:bg-primary file:text-white hover:file:opacity-90"
                />
                {restoreFile && (
                  <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                    已选:{restoreFile.name}({formatBytes(restoreFile.size)})
                  </p>
                )}
              </div>

              <div className="rounded-lg border border-danger-200 bg-danger-50 dark:bg-danger-900/20 dark:border-danger-800 px-3 py-2 space-y-1 text-xs text-danger-700 dark:text-danger-300">
                <div className="font-medium">会覆盖当前库里的所有数据:用户、线路、转发、节点、网站配置都换成备份里的。</div>
                <div>执行前会自动把当前库备份成 before_restore_*.sql,恢复错了还能退回去。</div>
                <div>恢复后所有节点会先显示离线,等它们重新连上这台面板会自动变绿(1~2 分钟)。</div>
                <div>面板后端地址等配置也会用备份里的值;换机器后记得去上面「基本设置」核对。</div>
              </div>
            </ModalBody>
            <ModalFooter>
              <Button variant="light" onClick={() => setRestoreOpen(false)} isDisabled={restoring}>
                取消
              </Button>
              <Button color="danger" isLoading={restoring} isDisabled={!restoreFile} onClick={handleRestore}>
                {restoring ? '恢复中...' : '确定恢复'}
              </Button>
            </ModalFooter>
          </ModalContent>
        </Modal>
      </div>
    
  );
} 