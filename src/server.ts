import { createServer } from './app.js'
import { env } from './config/env.js'
import { logger } from './utils/logger.js'
import { testConnection } from './database/db.js'
import { KeyManager } from './core/crypto/KeyManager.js'
import { BackgroundTaskManager } from './services/BackgroundTaskManager.js'

// Create server instance
const server = await createServer()

// Start server
try {
  // Test database connection
  logger.info('Testing database connection...')
  await testConnection()
  logger.info('Database connection successful')

  // Preload active keysets into cache
  const keyManager = server.diContainer.resolve<KeyManager>('keyManager')
  await keyManager.preloadActiveKeysets()

  // Start background tasks
  const backgroundTasks = server.diContainer.resolve<BackgroundTaskManager>('backgroundTasks')
  backgroundTasks.start()

  // Start HTTP server
  await server.listen({
    port: env.PORT,
    host: env.HOST,
  })

  logger.info(`🚀 UNIT Mint server running on http://${env.HOST}:${env.PORT}`)
  logger.info(`📝 Mint info: http://${env.HOST}:${env.PORT}/v1/info`)
  logger.info(`🌐 Network: ${env.NETWORK}`)
  logger.info(`🎯 UNIT Rune ID: ${env.SUPPORTED_RUNES}`)
  logger.info(`⏰ Background tasks: Deposit monitoring + UTXO sync`)
} catch (err) {
  logger.error(err, 'Failed to start server')
  process.exit(1)
}

// Graceful shutdown
const signals = ['SIGINT', 'SIGTERM']
signals.forEach((signal) => {
  process.on(signal, async () => {
    logger.info(`Received ${signal}, shutting down gracefully`)

    // Stop background tasks first
    const backgroundTasks = server.diContainer.resolve<BackgroundTaskManager>('backgroundTasks')
    backgroundTasks.stop()

    // Close HTTP server
    await server.close()

    process.exit(0)
  })
})
