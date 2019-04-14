import { isPlainObject, createAxios } from './utils'
import LocalStorageCache from './cache/LocalStorageCache'
import NullCache from './cache/NullCache'
import pDebounce from 'p-debounce'
import Axios from 'axios'
const { CancelToken } = Axios

export const EVENT_SUCCESS = 'success'
export const EVENT_ERROR = 'error'
export const EVENT_CANCEL = 'cancel'
export const EVENT_LOADING = 'loading'
export const EVENT_TIMEOUT = 'timeout'

export default class Resource {
  static from (value, baseOptions = {}) {
    if (value == null) throw new Error('Cannot create resource from `null`')

    if (value instanceof Resource) { return value }

    if (typeof value === 'string') { return new Resource(value, 'get', baseOptions) }

    if (isPlainObject(value)) {
      const { url, method, ...options } = value
      return new Resource(url, method, Object.assign({}, baseOptions, options))
    }
  }

  constructor (url, method, options) {
    options = options || {}
    method = method ? method.toLowerCase() : 'get'
    if (method &&
      ['get', 'post', 'put', 'patch', 'delete'].indexOf(method) === -1) {
      throw new Error('Bad Method requested: ' + method)
    }

    this.axios = createAxios(options.axios)

    this.requestConfig = {
      url: url,
      method: method ? method.toLowerCase() : 'get',
      headers: options.headers || {},
      cancelToken: new CancelToken(c => { this._canceler = c })
    }

    this.requestConfig[this.requestConfig.method === 'get' ? 'params' : 'data'] = options.params

    this._loading = false
    this._status = null
    this._data = null
    this._headers = null
    this._error = null
    this._lastLoaded = null
    this._eventListeners = {}
    this.keepData = !!options.keepData

    this.ssrPrefetched = false

    this.prefetch = typeof options.prefetch === 'string' ? options.prefetch.toLowerCase() === method : Boolean(options.prefetch)
    this.ssrPrefetch = options.ssrPrefetch
    this.cache = this.getCache(options.cache)
    this.fetchDebounced = pDebounce(this.fetch.bind(this), options.debounce || 80, { leading: true })

    // Set Transformers
    if (options.transformer) {
      if (typeof options.transformer === 'function') {
        this.setTransformer(options.transformer)
      } else if (typeof options.transformer === 'object') {
        this.setResponseTransformer(options.transformer.response)
        this.setErrorTransformer(options.transformer.error)
      }
    }
    this.responseTransformer = this.responseTransformer || (r => r)
    this.errorTransformer = this.errorTransformer || (r => r)

    // Set interval.
    if (options.interval) {
      this.startInterval(options.interval)
    }

    // Set Events
    if (typeof options.on === 'object' && options.on) {
      for (let key in options.on) {
        this.on(key, options.on[key])
      }
    }
  }

  setResponseTransformer (transformer) {
    this.responseTransformer = transformer
  }

  setErrorTransformer (transformer) {
    this.errorTransformer = transformer
  }

  setTransformer (transformer) {
    this.responseTransformer = transformer
    this.errorTransformer = transformer
  }

  startInterval (ms) {
    if (typeof process !== 'undefined' && process.server) return

    if (ms) this._interval = ms
    this.stopInterval()
    this._interval_id = setInterval(() => this.reload(true), this._interval)
  }

  stopInterval () {
    if (this._interval_id) clearInterval(this._interval_id)
  }

  on (event, handler) {
    let listeners = this._eventListeners[event] || []
    listeners.push(handler)
    this._eventListeners[event] = listeners
    return this
  }

  bindListeners (obj) {
    Object.keys(this._eventListeners).forEach(key => {
      (this._eventListeners[key] || []).forEach((handler, i) => {
        this._eventListeners[key][i] = handler.bind(obj)
      })
    })
  }

  emit (event) {
    (this._eventListeners[event] || []).forEach(handler => {
      handler(this)
    })
  }

  fetch (force, extraData) {
    return new Promise((resolve, reject) => {
      let setByResponse = (res) => {
        this._error = null
        this._loading = false
        if (res) {
          this._status = res.status
          this._data = this.responseTransformer(res.data)
          this._headers = res.headers
          this._lastLoaded = new Date()
        }
      }

      if (this.cache && !force) {
        let cacheValue = this.cache.getItem(this.getCacheKey())
        if (cacheValue) {
          setByResponse(cacheValue)
          resolve(cacheValue)
          return
        }
      }

      this._loading = true
      this.emit(EVENT_LOADING)

      // Assign Extra data
      let requestConfig = Object.assign({}, this.requestConfig, typeof extraData === 'object' ? {
        [this.requestConfig.method === 'get' ? 'params' : 'data']: extraData
      } : {})

      this.axios.request(requestConfig).then(res => {
        setByResponse(res)
        this.setCache(res)
        this.emit(EVENT_SUCCESS)
        resolve(res)
      }).catch(err => {
        this._data = null
        this._loading = false
        const errorResponse = err.response
        if (errorResponse) {
          this._status = errorResponse.status
          this._error = this.errorTransformer(errorResponse.data)
          this._headers = errorResponse.headers
        }
        if (Axios.isCancel(err)) {
          this.emit(EVENT_CANCEL)
        } else if (err.message && !err.response && err.message.indexOf('timeout') !== -1) {
          this.emit(EVENT_TIMEOUT)
        } else {
          this.emit(EVENT_ERROR)
        }

        reject(err)
      })
    })
  }

  reload (force) {
    return this.fetchDebounced(force)
  }

  execute () {
    return this.fetchDebounced(true)
  }

  send (extra) {
    return this.fetchDebounced(true, extra)
  }

  cancel (unload) {
    this.stopInterval()
    if (unload) this._data = null
    if (typeof this._canceler === 'function') this._canceler()
    this.requestConfig.cancelToken = new CancelToken(c => { this._canceler = c })
  }

  stop () {
    this.cancel()
  }

  getCache (cache) {
    const caches = {
      'no-cache': () => new NullCache(),
      'localStorage': () => new LocalStorageCache(this.getConfig().cacheExpiration || 10000)
    }
    cache = cache || 'no-cache'
    return caches[cache] ? caches[cache]() : null
  }

  getCacheKey () {
    return (typeof window !== 'undefined' && typeof btoa !== 'undefined'
      ? window.btoa
      : x => x)(this.requestConfig.url +
      this.requestConfig.params +
      this.requestConfig.data +
      this.requestConfig.method)
  }

  setCache (value) {
    if (this.cache) { this.cache.setItem(this.getCacheKey(), value) }
  }

  toJSON () {
    const json = {};
    ['_loading', '_status', '_data', '_headers', '_error', '_lastLoaded', 'ssrPrefetched'].forEach(key => {
      json[key] = this[key]
    })
    return JSON.stringify(json)
  }

  get loading () {
    return this._loading
  }

  get status () {
    return this._status
  }

  get data () {
    return this._data
  }

  get headers () {
    return this._headers
  }

  get error () {
    return this._error
  }

  get lastLoaded () {
    return this._lastLoaded
  }
}
