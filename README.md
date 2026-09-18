🚀 节点质量分析仪 (Node Analyzer) 部署全指南

本项目实现了一个专业的代理节点延迟探测系统。通过 Go + Docker (Alpine) 构建高性能后端，Cloudflare Tunnel
实现安全内网穿透，Vue 3 + Tailwind CSS 构建现代化的前端仪表盘。

🛠️ 项目架构

用户浏览器 \rightarrow CF Pages (前端) \rightarrow CF Tunnel (公网入口) \rightarrow 软路由
Docker (Go 后端) \rightarrow 目标节点

第一阶段：后端探测引擎部署 (iStoreOS/OpenWrt)

1. 创建工作目录

建议在存储空间较大的分区创建，避免占满根目录。

mkdir -p /vio2-4/docker/node-probe
cd /vio2-4/docker/node-probe

2. 写入后端代码 main.go

使用 cat 命令原样写入，确保 JSON 标签的反引号不被 Shell 解析。

cat <<'EOF' > main.go
package main

import (
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

type Node struct {
	Name    string `json:"name"`
	Link    string `json:"link"`
	Country string `json:"country"`
	Latency int    `json:"latency"`
	IsAlive bool   `json:"isAlive"`
}

func main() {
	gin.SetMode(gin.ReleaseMode)
	r := gin.Default()

	r.Use(func(c *gin.Context) {
		c.Writer.Header().Set("Access-Control-Allow-Origin", "*")
		c.Writer.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}
		c.Next()
	})

	r.GET("/parse", func(c *gin.Context) {
		url := c.Query("url")
		if url == "" {
			c.JSON(400, gin.H{"error": "缺少 url 参数"})
			return
		}
		var nodes []Node
		if strings.HasPrefix(url, "http") {
			nodes, _ = parseSubscription(url)
		} else {
			nodes = []Node{{Name: "单节点 1", Link: url, Country: "Unknown"}}
		}
		c.JSON(200, nodes)
	})

	r.GET("/ping", func(c *gin.Context) {
		link := c.Query("link")
		if link == "" {
			c.JSON(400, gin.H{"error": "缺少 link 参数"})
			return
		}
		latency, country, alive := probeRealNode(link)
		c.JSON(200, gin.H{
			"latency": latency,
			"country": country,
			"alive":   alive,
		})
	})
	r.Run(":8080")
}

func parseSubscription(url string) ([]Node, error) {
	resp, err := http.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	content := string(body)
	decoded, err := base64.StdEncoding.DecodeString(content)
	if err != nil {
		return splitNodes(content), nil
	}
	return splitNodes(string(decoded)), nil
}

func splitNodes(content string) []Node {
	var nodes []Node
	lines := strings.Split(content, "\n")
	count := 1
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" { continue }
		if strings.HasPrefix(line, "vmess://") || strings.HasPrefix(line, "vless://") || 
		   strings.HasPrefix(line, "ss://") || strings.HasPrefix(line, "trojan://") {
			nodes = append(nodes, Node{Name: fmt.Sprintf("节点 %d", count), Link: line, Country: "Unknown"})
			count++
		}
	}
	return nodes
}

func probeRealNode(link string) (int, string, bool) {
	var hostPort string
	if strings.Contains(link, "@") {
		parts := strings.Split(link, "@")
		hostPort = strings.Split(parts[1], "?")[0]
	} else {
		return 999, "Unknown", false
	}
	start := time.Now()
	conn, err := net.DialTimeout("tcp", hostPort, 5*time.Second)
	if err != nil {
		return 999, "Offline", false
	}
	defer conn.Close()
	elapsed := int(time.Since(start).Milliseconds())
	host, _, _ := net.SplitHostPort(hostPort)
	country := "Unknown"
	geoResp, err := http.Get("http://ip-api.com/line/" + host + "?fields=country")
	if err == nil {
		geoBody, _ := io.ReadAll(geoResp.Body)
		country = strings.TrimSpace(string(geoBody))
		geoResp.Body.Close()
	}
	return elapsed, country, true
}
EOF

3. 写入 Dockerfile

cat <<EOF > Dockerfile
FROM golang:1.23-alpine AS builder
ENV GOPROXY=https://goproxy.cn,direct
WORKDIR /app
COPY main.go .
RUN go mod init node-probe && \
    go get github.com/gin-gonic/gin@v1.9.1 && \
    go mod tidy
RUN CGO_ENABLED=0 GOOS=linux go build -o probe-engine main.go

FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /root/
COPY --from=builder /app/probe-engine .
EXPOSE 8080
CMD ["./probe-engine"]
EOF

4. 构建并启动

docker build -t node-probe-engine .
docker run -d --name node-probe --restart always -p 8080:8080 node-probe-engine

第二阶段：内网穿透部署 (Cloudflare Tunnel)

1. 创建隧道

  - 登录 Cloudflare Zero Trust \rightarrow Networks \rightarrow Tunnels
    \rightarrow Create a Tunnel。
  - 选择 Cloudflared \rightarrow 命名隧道 \rightarrow 保存。
  - 在 Install and run a connector 页面，选择 Docker \rightarrow 复制 --token 后面的那一长串
    Token。

2. 在软路由部署 Tunnel 容器

# 请将 你的TOKEN 替换为实际复制的内容
docker run -d \
  --name cf-tunnel \
  --restart always \
  --network host \
  cloudflare/cloudflared:latest \
  tunnel --no-autoupdate run --token 你的TOKEN

3. 配置公网域名 (Public Hostname)

在 CF Tunnel 管理页面的 Public Hostname 中添加：

  - Public Hostname: api.yourdomain.com (你的域名)
  - Service: http://127.0.0.1:8080

第三阶段：前端仪表盘部署 (CF Pages / GitHub Pages)

1. 前端代码 index.html

  - 使用最新的 Vue 3 + Tailwind CSS 版本。
  - 核心功能：支持单节点/订阅解析、TCP 真延迟探测、自动低\rightarrow高排序、国家筛选、一键批量复制。
  - API 配置：代码中包含一个“齿轮”设置按钮，可在网页端动态修改 API 地址并保存在本地 (localStorage)。

2. 部署方式

  - 方案 A (简单)：上传 index.html 到 GitHub Pages \rightarrow 绑定自定义域名。
  - 方案 B (专业)：上传到 Cloudflare Pages \rightarrow 在环境变量中设置 B_IP \rightarrow 使用
    functions/_middleware.js 实现变量自动注入。

🛠️ 常见问题排查

| 现象                       | 原因               | 解决方法                                                                           |
| :----------------------- | :--------------- | :----------------------------------------------------------------------------- |
| `docker build` 镜像下载超时    | Docker Hub 网络不稳定 | 1\. 修改 `/etc/docker/daemon.json` 添加镜像站<br>2\. 执行 `docker build --network host` |
| 访问域名显示 `502 Bad Gateway` | 隧道通了但找不到后端       | 检查 CF Tunnel 的 Service 是否为 `http://127.0.0.1:8080`                             |
| 网页端显示 `Testing...` 不变    | API 请求被拦截或不通     | 1\. 检查 API 地址是否带 `https://`<br>2\. 检查 F12 控制台是否有 CSP 报错                        |
| 延迟显示 999ms               | 节点不通或格式错误        | 确保输入的是标准的 `vmess/vless/ss/trojan` 链接                                           |

=======
