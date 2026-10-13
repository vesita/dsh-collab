// src/client-route.ts
// **浏览器半边：只读 loopback 路由**。浏览器拿不到包的安装位置，「随包 skill 的绝对路径」
// 只能由 host 交出；这是双方唯一的共享事实。webServer 是可选服务：没组合它时整段静默跳过。
// 但一旦路由注册上了，`connection` 围栏就是**必须**的：拿不到就 fail-closed（不服务），
// 否则路径校验缺席 = 任何能连端口的人都能读到安装布局（见 handler 内注释与测试）。

import type { IncomingMessage, ServerResponse } from 'node:http'
import { CLIENT_SKILL_ROUTE } from './spec.js'
import { buildSkillIndex, loadBundledSkill } from './skill.js'
import type { CollabContext, ConnectionService, WebServerService } from './contract.js'

/** 写一个 JSON 响应（no-store：路径与状态是活事实）。 */
function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  if (res.headersSent) return
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(JSON.stringify(payload))
}

export function installClientRoute(ctx: CollabContext): void {
  ctx.inject(['webServer'], (webCtx) => {
    try {
      const webServer = webCtx.webServer
      if (!webServer || typeof webServer.register !== 'function') return
      webCtx.effect(() => webServer.register({
        kind: 'exact',
        path: CLIENT_SKILL_ROUTE,
        handler: (req: IncomingMessage, res: ServerResponse) => {
          // 围栏是这条路由**唯一**的一道闸：webServer 自己的分发只做路径匹配，不校验
          // Host / Origin / 令牌。所以拿不到 connection 服务或 requestRejection 时**不服务**
          // （fail-closed）—— 与生态一致（dsh-host-open-in-app 拿不到 connection 时抛错、不服务）。
          // 静默 fail-open 的代价实测过：任何人只要能连上端口，就能 GET 到随包 SKILL.md 的
          // **绝对路径**（泄露 home 目录 / 安装布局）。
          const connection = ctx.get('connection') as ConnectionService | undefined
          let rejection: number | undefined
          try {
            if (!connection || typeof connection.requestRejection !== 'function') {
              sendJson(res, 503, { error: '围栏缺席：拿不到 connection.requestRejection，拒绝服务（fail-closed）' })
              return
            }
            rejection = connection.requestRejection(req)
          } catch (e) {
            sendJson(res, 503, { error: '围栏检查失败：' + String((e && (e as Error).message) || e) + '（fail-closed）' })
            return
          }
          if (rejection !== undefined) {
            res.statusCode = rejection
            res.end()
            return
          }
          if (req.method !== 'GET') {
            res.setHeader('Allow', 'GET')
            sendJson(res, 405, { error: '仅支持 GET' })
            return
          }
          sendJson(res, 200, buildSkillIndex(loadBundledSkill()))
        }
      }), `dsh-collab: GET ${CLIENT_SKILL_ROUTE}`)
    } catch (e) {}
  })
}
