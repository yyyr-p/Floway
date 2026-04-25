import type { Hono } from "hono";
import { DashboardPage } from "../../ui/dashboard.tsx";
import { LoginPage } from "../../ui/login.tsx";

export const mountPageRoutes = (app: Hono) => {
  app.get("/", (c) => {
    const accept = c.req.header("accept") ?? "";
    if (accept.includes("application/json") && !accept.includes("text/html")) {
      return c.json({ status: "ok", service: "copilot-deno" });
    }
    return c.html(LoginPage());
  });

  app.get("/dashboard", (c) => c.html(DashboardPage()));
  app.get("/favicon.ico", () => new Response(null, { status: 204 }));
};
