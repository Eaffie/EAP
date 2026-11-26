import axios, { AxiosResponse } from 'axios';
import { getPanelAddresses, isWebViewFunc} from '@/utils/panel';


interface PanelAddress {
  name: string;
  address: string;   
  inx: boolean;
}

const setPanelAddressesFunc = (newAddress: PanelAddress[]) => {
  newAddress.forEach(item => {
    if (item.inx) {
      baseURL = `${item.address}/api/v1/`;
      axios.defaults.baseURL = baseURL;
    }
  });
}

function getWebViewPanelAddress() {
  (window as any).setAddresses = setPanelAddressesFunc
  getPanelAddresses("setAddresses");
};

let baseURL: string = '';

export const reinitializeBaseURL = () => {
  if (isWebViewFunc()) {
    getWebViewPanelAddress();
  } else {
    baseURL = import.meta.env.VITE_API_BASE ? `${import.meta.env.VITE_API_BASE}/api/v1/` : '/api/v1/';
    axios.defaults.baseURL = baseURL;
  }
};

reinitializeBaseURL();


interface ApiResponse<T = any> {
  code: number;
  msg: string;
  data: T;
}

// 处理token失效的逻辑
function handleTokenExpired() {
  // 清除localStorage中的token
  window.localStorage.removeItem('token');
  window.localStorage.removeItem('role_id');
  window.localStorage.removeItem('name');
  
  // 跳转到登录页面
  if (window.location.pathname !== '/') {
    window.location.href = '/';
  }
}

// 检查响应是否为token失效
function isTokenExpired(response: ApiResponse) {
  return response && response.code === 401 && 
         (response.msg === '未登录或token已过期' || 
          response.msg === '无效的token或token已过期' ||
          response.msg === '无法获取用户权限信息');
}

/**
 * 慢接口的超时。
 *
 * 这些接口要跟【节点】来回通信:一台机器 6 个协议,每个协议都要下发 gost 服务、
 * 推限速器,而每次节点往返最多等 10 秒(后端 WebSocketServer.send_msg 的设定)。
 * 节点稍微慢一点,累加起来就轻松超过 30 秒 —— 用户看到的就是
 * "一点分配就卡住,过一会儿报 timeout of 30000ms exceeded"。
 *
 * 这里只放宽超时,不改变任何业务逻辑;真正减少往返次数的优化在后端做。
 */
const SLOW_PATHS = [
  '/inbound/assign-all',
  '/inbound/assign-self',
  '/inbound/assign',
  '/inbound/one-click',
  '/inbound/one-click-relay',
  // 「重推配置」:整机重建,这台机器下有多少条转发就有多少次节点往返,数量一多 30 秒不够
  '/inbound/push-config',
  '/inbound/delete-by-node',
  '/landing/test',
  '/node/install',
  '/node/enable-ipv6',
  '/node/disable-ipv6',
  '/forward/create',
  '/forward/update',
  '/tunnel/diagnose',
  '/forward/diagnose',
  // 恢复数据库:几十万行 INSERT 要一条条执行,监控全量备份时 30 秒肯定不够
  '/backup/import',
];
const DEFAULT_TIMEOUT = 30000;
const SLOW_TIMEOUT = 180000;

function timeoutFor(path: string): number {
  return SLOW_PATHS.some((p) => path.startsWith(p)) ? SLOW_TIMEOUT : DEFAULT_TIMEOUT;
}

const Network = {
  get: function<T = any>(path: string = '', data: any = {}): Promise<ApiResponse<T>> {
    return new Promise(function(resolve) {
      // 如果baseURL是默认值且是WebView环境，说明没有设置面板地址
      if (baseURL === '') {
        resolve({"code": -1, "msg": " - 请先设置面板地址", "data": null as T});
        return;
      }

      axios.get(path, {
        params: data,
        timeout: timeoutFor(path),
        headers: {
          "Authorization": window.localStorage.getItem('token')
        }
      })
        .then(function(response: AxiosResponse<ApiResponse<T>>) {
          // 检查是否token失效
          if (isTokenExpired(response.data)) {
            handleTokenExpired();
            return;
          }
          resolve(response.data);
        })
                 .catch(function(error: any) {
           console.error('GET请求错误:', error);
           
           // 检查是否是401错误（token失效）
           if (error.response && error.response.status === 401) {
             handleTokenExpired();
             return;
           }
           
           resolve({"code": -1, "msg": error.message || "网络请求失败", "data": null as T});
         });
    });
  },

  post: function<T = any>(path: string = '', data: any = {}): Promise<ApiResponse<T>> {
    return new Promise(function(resolve) {
      // 如果baseURL是默认值且是WebView环境，说明没有设置面板地址
      if (baseURL === '') {
        resolve({"code": -1, "msg": " - 请先设置面板地址", "data": null as T});
        return;
      }

      axios.post(path, data, {
        timeout: timeoutFor(path),
        headers: {
          "Authorization": window.localStorage.getItem('token'),
          "Content-Type": "application/json"
        }
      })
        .then(function(response: AxiosResponse<ApiResponse<T>>) {
          // 检查是否token失效
          if (isTokenExpired(response.data)) {
            handleTokenExpired();
            return;
          }
          resolve(response.data);
        })
                 .catch(function(error: any) {
           console.error('POST请求错误:', error);
           
           // 检查是否是401错误（token失效）
           if (error.response && error.response.status === 401) {
             handleTokenExpired();
             return;
           }
           
           resolve({"code": -1, "msg": error.message || "网络请求失败", "data": null as T});
         });
    });
  },

  /**
   * 上传(multipart/form-data)。
   * 不能走 post():那边写死了 Content-Type: application/json,boundary 会丢,后端收不到文件。
   * 这里不显式设 Content-Type,交给浏览器/axios 自己带 boundary。
   */
  upload: function<T = any>(path: string = '', form: FormData): Promise<ApiResponse<T>> {
    return new Promise(function(resolve) {
      if (baseURL === '') {
        resolve({"code": -1, "msg": " - 请先设置面板地址", "data": null as T});
        return;
      }

      axios.post(path, form, {
        timeout: timeoutFor(path),
        headers: {
          "Authorization": window.localStorage.getItem('token')
        }
      })
        .then(function(response: AxiosResponse<ApiResponse<T>>) {
          if (isTokenExpired(response.data)) {
            handleTokenExpired();
            return;
          }
          resolve(response.data);
        })
        .catch(function(error: any) {
          console.error('上传请求错误:', error);

          if (error.response && error.response.status === 401) {
            handleTokenExpired();
            return;
          }

          resolve({"code": -1, "msg": error.message || "上传失败", "data": null as T});
        });
    });
  },

  /**
   * 下载文件。
   * token 在 Authorization 头里,window.open 带不了它,只能 JS 里取成 blob 再触发下载。
   * 后端出错时不返回文件而是 {"code":-1,"msg":...},这里按 Content-Type 分辨。
   */
  download: function(path: string = '', data: any = {}): Promise<DownloadResult> {
    return new Promise(function(resolve) {
      if (baseURL === '') {
        resolve({ ok: false, msg: '请先设置面板地址' });
        return;
      }

      axios.post(path, null, {
        params: data,
        timeout: timeoutFor(path),
        responseType: 'blob',
        headers: {
          "Authorization": window.localStorage.getItem('token')
        }
      })
        .then(function(response: AxiosResponse<Blob>) {
          const blob = response.data;
          const type = (blob && blob.type) || '';
          if (type.indexOf('application/json') >= 0) {
            // 后端把错误当 JSON 回来了(文件不存在 / 文件名不合法)
            blob.text()
              .then(function(text: string) {
                let msg = '下载失败';
                try {
                  const parsed = JSON.parse(text);
                  if (parsed && parsed.msg) msg = parsed.msg;
                } catch (e) {
                  // 不是 JSON 就用默认文案
                }
                resolve({ ok: false, msg });
              })
              .catch(function() {
                resolve({ ok: false, msg: '下载失败' });
              });
            return;
          }
          const disposition = (response.headers && (response.headers['content-disposition'] as string)) || '';
          const matched = /filename="?([^";]+)"?/.exec(disposition);
          resolve({ ok: true, blob, filename: matched ? matched[1] : '' });
        })
        .catch(function(error: any) {
          console.error('下载请求错误:', error);

          if (error.response && error.response.status === 401) {
            handleTokenExpired();
            return;
          }

          resolve({ ok: false, msg: error.message || '下载失败' });
        });
    });
  }
};

export interface DownloadResult {
  ok: boolean;
  msg?: string;
  blob?: Blob;
  filename?: string;
}

export default Network; 