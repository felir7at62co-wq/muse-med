/** @type {import('next').NextConfig} */
const nextConfig = {
  // 关掉 StrictMode：在 dev 下会让副作用跑 2 次，导致 SSE reader 被意外 abort
  reactStrictMode: false,
  env: {
    // 默认空字符串 = 走同源相对路径 + next rewrites 代理
    // 如需跨域直连 orchestrator，通过 shell 环境变量 NEXT_PUBLIC_ORCHESTRATOR_URL 覆盖
    NEXT_PUBLIC_ORCHESTRATOR_URL: process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "",
  },
  // next dev/start 本身把 /v1/* 反代到 orchestrator，
  // 这样无论访问 http://host/ (走 nginx) 还是 http://host:3000/ (直连) 都能工作
  async rewrites() {
    const target = process.env.ORCHESTRATOR_INTERNAL_URL || "http://127.0.0.1:8000";
    return [{ source: "/v1/:path*", destination: `${target}/v1/:path*` }];
  },
};
export default nextConfig;
