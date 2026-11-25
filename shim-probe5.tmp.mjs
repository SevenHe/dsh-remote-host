import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const HOST = readFileSync('/tmp/pump-host-base.txt', 'utf8').trim()
const remoteId = JSON.parse(readFileSync('/tmp/remote-sessions.json', 'utf8')).result.value.items[0].sessionId
const shim = readFileSync('/Users/bytedance/Workspace/dsh-remote-host/lib/shim.js', 'utf8')
const dials = []

const sandbox = {
  console,
  location: { protocol: 'dsh-app:', href: 'dsh-app://app/', origin: 'dsh-app://app', pathname: '/' },
  document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {}, querySelectorAll: () => [], getElementById: () => null, getElementsByTagName: () => ({ length: 0 }) },
  performance: { memory: undefined },
  setTimeout, clearTimeout, setInterval, clearInterval,
  queueMicrotask,
  AbortController,
  fetch: (input, init) => fetch(new URL(String(input?.url ?? input), HOST), init),
  WebSocket: class NativeSocket {
    constructor(url) { this.url = String(url); this.readyState = 0; dials.push(['global', this.url]) }
    send() {}
    close() {}
    addEventListener() {}
    removeEventListener() {}
  },
}
sandbox.globalThis = sandbox
sandbox.window = sandbox
sandbox.self = sandbox
sandbox.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
sandbox.__DSH_TRANSPORT__ = {
  fetch: (input, init) => fetch(new URL(String(input?.url ?? input), HOST), init),
  createWebSocket: (url) => { dials.push(['carrier', String(url)]); return new sandbox.WebSocket(url) },
}
sandbox.__DSH_REMOTE_HOST__ = { mount: '/devbox', label: 'devbox', streams: true, trace: false, group: 'workspace', remoteBlock: true }
vm.createContext(sandbox)
vm.runInContext(shim, sandbox, { filename: 'lib/shim.js' })

// Let the shim learn the remote session set through the mount (real Host, real remote Host).
await new Promise((resolve) => setTimeout(resolve, 6000))
console.log('remote session known to the page:', remoteId)

const built = sandbox.__DSH_TRANSPORT__
const socket = built.createWebSocket('/api/remote.mux')
const events = []
socket.addEventListener('open', () => events.push('open'))
socket.addEventListener('message', (event) => events.push('message'))
socket.addEventListener('close', () => events.push('close'))
await new Promise((resolve) => setTimeout(resolve, 3000))
// Follow a stream for that remote session, exactly like the app's client does.
try {
  socket.send(JSON.stringify({ type: 'open', streamId: 's1', endpoint: 'session/follow', payload: { args: { sessionId: remoteId } } }))
} catch (error) { console.log('send failed:', String(error).slice(0, 80)) }
await new Promise((resolve) => setTimeout(resolve, 12000))
console.log('native dials:', JSON.stringify(dials))
console.log('socket events:', JSON.stringify(events))
console.log('readyState:', socket.readyState)
