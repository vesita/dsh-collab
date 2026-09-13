// src/client-route.ts
// **浏览器半边：只读 loopback 路由**。浏览器拿不到包的安装位置，「随包 skill 的绝对路径」
// 只能由 host 交出；这是双方唯一的共享事实。webServer 是可选服务：没组合它时整段静默跳过。

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
          const connection = ctx.get('connection') as ConnectionService | undefined
          if (connection && typeof connection.requestRejection === 'function') {
            const rejection = connection.requestRejection(req)
            if (rejection !== undefined) {
              res.statusCode = rejection
              res.end()
              return
            }
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
