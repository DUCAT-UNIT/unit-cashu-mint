import { FastifyPluginAsync } from 'fastify'
import { CheckStateService } from '../../core/services/CheckStateService.js'
import { MeltService } from '../../core/services/MeltService.js'
import { MintService } from '../../core/services/MintService.js'
import { CashuNotification, notificationBus } from '../../core/events/notifications.js'

interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number
  method?: string
  params?: {
    kind?: string
    filters?: string[]
    subId?: string
  }
}

interface Subscription {
  kind: string
  filters: Set<string>
  subId: string
}

type SocketLike = {
  send(data: string): void
  on(event: 'message' | 'close', listener: (data?: unknown) => void): void
  readyState: number
}

type WebSocketHandlerArg = SocketLike | { socket?: SocketLike }

function resolveSocket(connection: WebSocketHandlerArg): SocketLike | undefined {
  const direct = connection as Partial<SocketLike>
  if (typeof direct.on === 'function' && typeof direct.send === 'function') {
    return connection as SocketLike
  }

  return (connection as { socket?: SocketLike }).socket
}

export const wsRoutes: FastifyPluginAsync = async (fastify) => {
  const mintService = fastify.diContainer.resolve<MintService>('mintService')
  const meltService = fastify.diContainer.resolve<MeltService>('meltService')
  const checkStateService = fastify.diContainer.resolve<CheckStateService>('checkStateService')

  fastify.get('/v1/ws', { websocket: true }, (connection) => {
    const socket = resolveSocket(connection as WebSocketHandlerArg)
    if (!socket) {
      fastify.log.error('WebSocket connection did not include a socket')
      return
    }

    const subscriptions = new Map<string, Subscription>()

    const send = (message: Record<string, unknown>) => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify(message))
      }
    }

    const sendNotification = (subId: string, payload: Record<string, unknown>) => {
      send({
        jsonrpc: '2.0',
        method: 'subscribe',
        params: {
          subId,
          payload,
        },
      })
    }

    const onNotification = (notification: CashuNotification) => {
      for (const subscription of subscriptions.values()) {
        if (subscription.kind !== notification.kind) {
          continue
        }

        const id = notification.kind === 'proof_state'
          ? notification.payload.Y
          : notification.payload.quote

        if (typeof id === 'string' && subscription.filters.has(id)) {
          sendNotification(subscription.subId, notification.payload)
        }
      }
    }

    notificationBus.on('notification', onNotification)

    socket.on('message', (raw) => {
      void handleMessage(raw)
    })

    socket.on('close', () => {
      notificationBus.off('notification', onNotification)
      subscriptions.clear()
    })

    async function handleMessage(raw: unknown): Promise<void> {
      let rpc: JsonRpcRequest
      try {
        const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
        rpc = JSON.parse(text) as JsonRpcRequest
      } catch {
        return
      }

      if (rpc.method === 'subscribe') {
        await subscribe(rpc)
        return
      }

      if (rpc.method === 'unsubscribe') {
        const subId = rpc.params?.subId
        if (subId) {
          subscriptions.delete(subId)
        }
        send({
          jsonrpc: '2.0',
          result: { status: 'OK', subId },
          id: rpc.id,
        })
      }
    }

    async function subscribe(rpc: JsonRpcRequest): Promise<void> {
      const kind = rpc.params?.kind
      const filters = rpc.params?.filters ?? []
      const subId = rpc.params?.subId

      if (!kind || !subId) {
        send({
          jsonrpc: '2.0',
          error: { code: -32602, message: 'Invalid subscription params' },
          id: rpc.id,
        })
        return
      }

      subscriptions.set(subId, {
        kind,
        filters: new Set(filters),
        subId,
      })

      send({
        jsonrpc: '2.0',
        result: { status: 'OK', subId },
        id: rpc.id,
      })

      await sendInitialState(kind, filters, subId)
    }

    async function sendInitialState(kind: string, filters: string[], subId: string): Promise<void> {
      if (kind === 'bolt11_mint_quote') {
        for (const quoteId of filters) {
          const quote = await mintService.getMintQuote(quoteId)
          sendNotification(subId, quote as unknown as Record<string, unknown>)
        }
        return
      }

      if (kind === 'bolt11_melt_quote') {
        for (const quoteId of filters) {
          const quote = await meltService.getMeltQuote(quoteId)
          sendNotification(subId, quote as unknown as Record<string, unknown>)
        }
        return
      }

      if (kind === 'proof_state') {
        const { states } = await checkStateService.checkStateByYs(filters)
        for (const state of states) {
          sendNotification(subId, state as unknown as Record<string, unknown>)
        }
      }
    }
  })
}
