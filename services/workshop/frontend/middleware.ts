import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// 不需要登录的公开路径
const PUBLIC_PATHS = ["/login", "/register", "/forgot-password"];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 公开路径直接放行
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // 检查是否有token(通过cookie或让前端页面自己检查localStorage)
  // 这里不做服务端验证,交给客户端authFetch处理401跳转
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
