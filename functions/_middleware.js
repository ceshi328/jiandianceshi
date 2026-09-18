export async function onRequest(context) {
    // 1. 从 CF Pages 的环境变量中读取 B_IP
    const bIp = context.env.B_IP || 'https://fallback-api.com';

    // 2. 获取原本的静态 HTML 内容
    const response = await context.next();
    
    // 如果请求的不是 HTML，直接返回
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
        return response;
    }

    // 3. 将 HTML 中的 {{B_IP}} 替换为真实的变量值
    let html = await response.text();
    html = html.replace('{{B_IP}}', bIp);

    // 4. 返回替换后的 HTML
    return new Response(html, {
        headers: { 'content-type': 'text/html;charset=UTF-8' },
    });
}
