import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

export const { auth: middleware } = NextAuth(authConfig);

export const config = {
  // EXTENSION POINT: add protected route patterns for the app here.
  matcher: ["/dashboard/:path*"],
};
