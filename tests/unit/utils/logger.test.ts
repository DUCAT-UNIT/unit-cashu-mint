import { describe, it, expect } from 'vitest'
import { logger } from '../../../src/utils/logger.js'

describe('Logger', () => {
  it('should create logger instance', () => {
    expect(logger).toBeDefined()
    expect(typeof logger.info).toBe('function')
  })

  it('should have all logging methods', () => {
    expect(typeof logger.info).toBe('function')
    expect(typeof logger.error).toBe('function')
    expect(typeof logger.warn).toBe('function')
    expect(typeof logger.debug).toBe('function')
    expect(typeof logger.trace).toBe('function')
    expect(typeof logger.fatal).toBe('function')
  })

  it('should log without throwing', () => {
    expect(() => logger.info('test message')).not.toThrow()
    expect(() => logger.error('test error')).not.toThrow()
    expect(() => logger.warn('test warning')).not.toThrow()
    expect(() => logger.debug('test debug')).not.toThrow()
  })

  it('should have child method', () => {
    const child = logger.child({ test: 'value' })
    expect(child).toBeDefined()
    expect(typeof child.info).toBe('function')
  })

  it('should support structured logging', () => {
    expect(() => logger.info({ msg: 'test', data: 'value' })).not.toThrow()
  })
})
