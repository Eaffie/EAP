package socket

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"strings"
	"time"
)

// 面板下发的地址(SetPanelAddr 的 data)
type setPanelAddrRequest struct {
	Addr string `json:"addr"`
}

// 面板地址的延迟范围:12 台节点一起重启会让所有车友同时断线,随机错开。
const (
	panelAddrDelayMin = 3
	panelAddrDelayMax = 8
)

// panelConfigPath 节点自己的配置文件。
// 正常安装时 systemd 的 WorkingDirectory 就是 /etc/gost,相对路径和绝对路径是同一个文件;
// 用绝对路径优先,是为了在别的工作目录下手动跑也不会改错文件。
func panelConfigPath() string {
	const abs = "/etc/gost/config.json"
	if _, err := os.Stat(abs); err == nil {
		return abs
	}
	return "config.json"
}

// handleSetPanelAddr 处理面板下发的面板地址:
//   - 和本地一样 → 什么都不做
//   - 不一样   → 只改 config.json 的 addr(secret 等其它字段原样保留、权限不变),
//     随机延迟 3~8 秒后退出进程,由 systemd 拉起来用新地址重连
// 返回给面板的一句话(面板那边会记日志)。真正退出在 goroutine 里,保证响应先发出去。
func (w *WebSocketReporter) handleSetPanelAddr(data interface{}) (string, error) {
	jsonData, err := json.Marshal(data)
	if err != nil {
		return "", fmt.Errorf("序列化面板地址失败: %v", err)
	}
	var req setPanelAddrRequest
	if err := json.Unmarshal(jsonData, &req); err != nil {
		return "", fmt.Errorf("解析面板地址失败: %v", err)
	}
	addr := strings.TrimSpace(req.Addr)
	if addr == "" {
		return "", fmt.Errorf("面板地址为空")
	}

	path := panelConfigPath()
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("读取 %s 失败: %v", path, err)
	}
	// 用 map 而不是结构体:面板以后加字段也不会被这里丢掉
	var cfg map[string]interface{}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return "", fmt.Errorf("解析 %s 失败: %v", path, err)
	}
	cur, _ := cfg["addr"].(string)
	if strings.TrimSpace(cur) == addr {
		return fmt.Sprintf("面板地址未变(%s),无需重连", addr), nil
	}

	cfg["addr"] = addr
	out, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return "", fmt.Errorf("生成配置失败: %v", err)
	}
	// 先写同目录的临时文件再改名:权限保持原样(安装脚本给的是 600),
	// 而且不会出现"写到一半掉电,config.json 变半截"的情况
	mode := os.FileMode(0600)
	if st, statErr := os.Stat(path); statErr == nil {
		mode = st.Mode().Perm()
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, out, mode); err != nil {
		return "", fmt.Errorf("写入 %s 失败: %v", tmp, err)
	}
	if err := os.Chmod(tmp, mode); err != nil {
		os.Remove(tmp)
		return "", fmt.Errorf("设置 %s 权限失败: %v", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return "", fmt.Errorf("替换 %s 失败: %v", path, err)
	}

	delay := panelAddrDelayMin + rand.Intn(panelAddrDelayMax-panelAddrDelayMin+1)
	fmt.Printf("🔁 面板地址已更新: %s → %s,%d 秒后退出,由 systemd 拉起重连\n", cur, addr, delay)

	go func() {
		time.Sleep(time.Duration(delay) * time.Second)
		fmt.Println("🔁 重新连接面板(新地址已生效)")
		// 【为什么用非 0 退出码】install.sh 的单元是 Restart=always(本次一并改成 always,
		// 安装和更新两条路径都会刷新单元)。但机器上万一还是老的 Restart=on-failure,
		// 或者节点跑在 docker --restart=on-failure 里,退出码 0 是【不会】被拉起来的 ——
		// 那台节点就永远不上线了。非 0 退出在 always / on-failure 两种策略下都会重启,
		// 代价只是 systemd 日志里多一行 failed(紧接着就 restart)。
		os.Exit(1)
	}()

	return fmt.Sprintf("面板地址已更新为 %s,将在 %d 秒后重连", addr, delay), nil
}
