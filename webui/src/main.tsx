import { render } from "solid-js/web"
import { createSignal, createEffect, createMemo, For, Show, Switch, Match, onMount, onCleanup } from "solid-js"
import { RouterProvider, createRouter, createRoute, createRootRoute, Outlet, useNavigate, useParams } from "@tanstack/solid-router"
import { stream, type StreamResponse } from "@durable-streams/client"
import "./styles.css"

// In prod: served from same origin. In dev: Vite proxies to Go backend
const API_BASE = typeof window !== "undefined" ? window.location.origin : ""

// ============================================================================
// Types
// ============================================================================

interface HistoryEntry {
  sessionId?: string
  display: string
  timestamp: number
  project?: string
}

interface Session {
  sessionId: string
  display: string
  timestamp: number
  project?: string
}

interface ContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string
  is_error?: boolean
}

interface ConversationMessage {
  id: string
  type: string
  message?: {
    role: string
    content: string | ContentBlock[]
  }
  timestamp?: string
}

// ============================================================================
// Helpers
// ============================================================================

function formatToolInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input)
  if (entries.length === 0) return ""
  if (entries.length === 1) {
    const [key, value] = entries[0]
    if (typeof value === "string" && value.length < 100 && !value.includes("\n")) {
      return `${key}: ${value}`
    }
  }
  return JSON.stringify(input, null, 2)
}

// ============================================================================
// Block Components
// ============================================================================

function ThinkingBlock(props: { block: ContentBlock }) {
  const [expanded, setExpanded] = createSignal(false)
  const thinking = () => props.block.thinking || ""
  const preview = () => thinking().slice(0, 60).replace(/\n/g, " ") + (thinking().length > 60 ? "..." : "")

  return (
    <div class="border-l-2 border-gray-300 pl-2 py-0.5 my-0.5 text-xs">
      <button
        class="flex items-center gap-2 hover:bg-gray-100 rounded px-1 -ml-1 w-full text-left"
        onClick={() => setExpanded(!expanded())}
      >
        <span class="text-gray-400 italic">thinking</span>
        <span class="text-gray-400 truncate flex-1">{preview()}</span>
        <span class="text-gray-300">{expanded() ? "▼" : "▶"}</span>
      </button>
      <Show when={expanded()}>
        <pre class="text-xs text-gray-600 bg-gray-50 rounded p-2 mt-1 whitespace-pre-wrap">{thinking()}</pre>
      </Show>
    </div>
  )
}

function ToolUseBlock(props: { block: ContentBlock }) {
  const [expanded, setExpanded] = createSignal(false)
  const inputStr = () => props.block.input ? formatToolInput(props.block.input) : ""
  const hasInput = () => inputStr().length > 0
  const preview = () => inputStr().slice(0, 60).replace(/\n/g, " ") + (inputStr().length > 60 ? "..." : "")

  return (
    <div class="border-l-2 border-purple-300 pl-2 py-0.5 my-0.5 text-xs">
      <button
        class="flex items-center gap-2 hover:bg-purple-50 rounded px-1 -ml-1 w-full text-left"
        onClick={() => hasInput() && setExpanded(!expanded())}
      >
        <span class="text-purple-600 font-mono font-medium">{props.block.name}</span>
        <Show when={hasInput()}>
          <span class="text-gray-400 truncate flex-1">{preview()}</span>
          <span class="text-gray-300">{expanded() ? "▼" : "▶"}</span>
        </Show>
      </button>
      <Show when={expanded() && hasInput()}>
        <pre class="text-xs bg-purple-50 rounded p-2 mt-1 overflow-x-auto whitespace-pre-wrap break-all">
          {inputStr()}
        </pre>
      </Show>
    </div>
  )
}

function ToolResultBlock(props: { block: ContentBlock }) {
  const [expanded, setExpanded] = createSignal(false)
  const isError = () => props.block.is_error
  const content = () => props.block.content || ""
  const hasContent = () => content().length > 0
  const preview = () => content().slice(0, 60).replace(/\n/g, " ") + (content().length > 60 ? "..." : "")

  return (
    <div class={`border-l-2 pl-2 py-0.5 my-0.5 text-xs ${isError() ? "border-red-300" : "border-green-300"}`}>
      <button
        class={`flex items-center gap-2 rounded px-1 -ml-1 w-full text-left ${isError() ? "hover:bg-red-50" : "hover:bg-green-50"}`}
        onClick={() => hasContent() && setExpanded(!expanded())}
      >
        <span class={`font-medium ${isError() ? "text-red-500" : "text-green-500"}`}>
          {isError() ? "err" : "ok"}
        </span>
        <Show when={hasContent()}>
          <span class="text-gray-400 truncate flex-1">{preview()}</span>
          <span class="text-gray-300">{expanded() ? "▼" : "▶"}</span>
        </Show>
      </button>
      <Show when={expanded() && hasContent()}>
        <pre class={`text-xs rounded p-2 mt-1 overflow-x-auto whitespace-pre-wrap break-all max-h-48 overflow-y-auto ${isError() ? "bg-red-50" : "bg-green-50"}`}>
          {content().slice(0, 2000)}{content().length > 2000 ? "..." : ""}
        </pre>
      </Show>
    </div>
  )
}

function ContentBlockRenderer(props: { block: ContentBlock }) {
  return (
    <Switch fallback={null}>
      <Match when={props.block.type === "text"}>
        <div class="whitespace-pre-wrap text-sm">{props.block.text}</div>
      </Match>
      <Match when={props.block.type === "thinking"}>
        <ThinkingBlock block={props.block} />
      </Match>
      <Match when={props.block.type === "tool_use"}>
        <ToolUseBlock block={props.block} />
      </Match>
      <Match when={props.block.type === "tool_result"}>
        <ToolResultBlock block={props.block} />
      </Match>
    </Switch>
  )
}

// ============================================================================
// Global stores
// ============================================================================

const [sessionMap, setSessionMap] = createSignal<Map<string, Session>>(new Map())
const [messageStore, setMessageStore] = createSignal<Map<string, ConversationMessage[]>>(new Map())

function getMessagesForSession(sessionId: string): ConversationMessage[] {
  return messageStore().get(sessionId) ?? []
}

function setMessagesForSession(sessionId: string, messages: ConversationMessage[]) {
  setMessageStore(prev => {
    const updated = new Map(prev)
    updated.set(sessionId, messages)
    return updated
  })
}

function appendMessagesForSession(sessionId: string, newMessages: ConversationMessage[]) {
  setMessageStore(prev => {
    const updated = new Map(prev)
    const existing = updated.get(sessionId) ?? []
    updated.set(sessionId, [...existing, ...newMessages])
    return updated
  })
}

// ============================================================================
// Routes (defined first, before components that use router hooks)
// ============================================================================

const rootRoute = createRootRoute({
  component: RootLayout,
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: IndexPage,
})

const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$sessionId",
  component: SessionPage,
})

const routeTree = rootRoute.addChildren([indexRoute, sessionRoute])
const router = createRouter({ routeTree })

// ============================================================================
// Components
// ============================================================================

function RootLayout() {
  return (
    <div class="h-screen flex flex-col">
      <header class="border-b px-4 py-3 bg-white dark:bg-gray-800">
        <h1 class="text-xl font-semibold">Claude Streams</h1>
      </header>
      <div class="flex-1 flex overflow-hidden">
        <SessionList />
        <Outlet />
      </div>
    </div>
  )
}

function SessionList() {
  const navigate = useNavigate()
  const params = useParams({ strict: false })

  const [connectionStatus, setConnectionStatus] = createSignal<"connecting" | "connected" | "error">("connecting")
  let streamResponse: StreamResponse | null = null
  let abortController: AbortController | null = null

  const sessions = createMemo(() => {
    return [...sessionMap().values()]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 100)
  })

  function processHistoryBatch(entries: readonly HistoryEntry[]) {
    setSessionMap((prev) => {
      const updated = new Map(prev)
      for (const entry of entries) {
        if (!entry.sessionId) continue
        const existing = updated.get(entry.sessionId)
        if (!existing || entry.timestamp > existing.timestamp) {
          updated.set(entry.sessionId, {
            sessionId: entry.sessionId,
            display: entry.display,
            timestamp: entry.timestamp,
            project: entry.project,
          })
        }
      }
      return updated
    })
  }

  async function connect() {
    setConnectionStatus("connecting")
    abortController = new AbortController()

    try {
      streamResponse = await stream({
        url: `${API_BASE}/_history`,
        offset: "-1",
        json: true,
        signal: abortController.signal,
        onError: (err) => {
          console.error("Stream error:", err)
          setConnectionStatus("error")
          return {} // Retry with backoff
        },
      })

      setConnectionStatus("connected")

      streamResponse.subscribeJson<HistoryEntry>(async (batch) => {
        console.log(`History: ${batch.items.length} items`)
        processHistoryBatch(batch.items)
      })
    } catch (err) {
      console.error("Failed to connect:", err)
      setConnectionStatus("error")
    }
  }

  onMount(() => connect())
  onCleanup(() => {
    streamResponse?.cancel()
    abortController?.abort()
  })

  const formatTime = (ts: number) => new Date(ts).toLocaleString()
  const truncate = (s: string, len: number) => s.length <= len ? s : s.slice(0, len) + "..."

  return (
    <aside class="w-80 border-r overflow-y-auto bg-gray-50 dark:bg-gray-900 flex flex-col">
      <div class="p-2 border-b bg-white dark:bg-gray-800 sticky top-0">
        <div class="flex items-center justify-between">
          <h2 class="font-medium text-sm text-gray-600">Recent Sessions</h2>
          <span class="text-xs">
            <Show when={connectionStatus() === "connected"}>
              <span class="text-green-600">●</span>
            </Show>
            {" "}{sessions().length}
          </span>
        </div>
      </div>
      <div class="divide-y flex-1 overflow-y-auto">
        <For each={sessions()}>
          {(session) => (
            <button
              class={`w-full text-left p-3 hover:bg-gray-100 transition-colors ${
                params()?.sessionId === session.sessionId ? "bg-blue-50 border-l-2 border-blue-500" : ""
              }`}
              onClick={() => navigate({ to: "/$sessionId", params: { sessionId: session.sessionId } })}
            >
              <div class="text-sm font-medium truncate">{truncate(session.display, 60)}</div>
              <div class="text-xs text-gray-500 mt-1">{formatTime(session.timestamp)}</div>
            </button>
          )}
        </For>
      </div>
    </aside>
  )
}

function IndexPage() {
  return (
    <main class="flex-1 flex items-center justify-center text-gray-400">
      Select a session to view
    </main>
  )
}

function SessionPage() {
  // Route.useParams() returns an accessor function in Solid
  const params = sessionRoute.useParams()
  const sessionId = () => params().sessionId

  // These are set inside the effect but need to be accessible for cleanup
  let streamResponse: StreamResponse | null = null
  let abortController: AbortController | null = null
  let scrollContainer: HTMLElement | undefined

  const [isAttachedToBottom, setIsAttachedToBottom] = createSignal(true)
  const messages = createMemo(() => getMessagesForSession(sessionId()))

  // Check if scrolled near bottom (within 100px threshold)
  function checkIfAtBottom() {
    if (!scrollContainer) return true
    const threshold = 100
    return scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight < threshold
  }

  function handleScroll() {
    setIsAttachedToBottom(checkIfAtBottom())
  }

  function scrollToBottom() {
    if (scrollContainer) {
      scrollContainer.scrollTop = scrollContainer.scrollHeight
    }
  }

  // Auto-scroll when messages change (if attached)
  createEffect(() => {
    const _ = messages() // track messages
    if (isAttachedToBottom()) {
      // Use setTimeout to ensure DOM has updated
      setTimeout(scrollToBottom, 0)
    }
  })

  createEffect(() => {
    const id = sessionId()
    if (!id) return

    // Cancel any existing stream for this effect instance
    streamResponse?.cancel()
    abortController?.abort()

    // Reset state for new conversation
    setMessagesForSession(id, [])
    setIsAttachedToBottom(true)

    // Set up new stream
    const controller = new AbortController()
    abortController = controller

    ;(async () => {
      try {
        const response = await stream({
          url: `${API_BASE}/${id}`,
          offset: "-1",
          json: true,
          signal: controller.signal,
          onError: (err) => {
            console.error("Conversation error:", err)
            return {} // Retry with backoff
          },
        })

        // Store for cleanup
        streamResponse = response

        response.subscribeJson<Omit<ConversationMessage, "id">>(async (batch) => {
          // Guard against stale subscriptions
          if (controller.signal.aborted) return

          console.log(`Conversation ${id}: ${batch.items.length} messages`)
          const newMessages = batch.items.map((msg, i) => ({
            id: `${batch.offset}-${i}`,
            type: msg.type,
            message: msg.message,
            timestamp: msg.timestamp,
          }))
          appendMessagesForSession(id, newMessages)
        })
      } catch (err) {
        if (!controller.signal.aborted) {
          console.error("Failed to load conversation:", err)
        }
      }
    })()

    // Cleanup when effect re-runs or component unmounts
    onCleanup(() => {
      controller.abort()
      streamResponse?.cancel()
    })
  })

  function getContentBlocks(msg: ConversationMessage): ContentBlock[] {
    if (!msg.message?.content) return []
    if (typeof msg.message.content === "string") {
      return [{ type: "text", text: msg.message.content }]
    }
    return msg.message.content
  }

  function handleScrollToBottom() {
    scrollToBottom()
    setIsAttachedToBottom(true)
  }

  // Check if message has actual text content (not just tool/thinking blocks)
  function hasTextContent(msg: ConversationMessage): boolean {
    const blocks = getContentBlocks(msg)
    return blocks.some(b => b.type === "text" && b.text?.trim())
  }

  // Check if message only has tool-related blocks
  function isToolOnlyMessage(msg: ConversationMessage): boolean {
    const blocks = getContentBlocks(msg)
    return blocks.length > 0 && blocks.every(b =>
      b.type === "tool_use" || b.type === "tool_result" || b.type === "thinking"
    )
  }

  return (
    <div class="flex-1 relative overflow-hidden">
      <main ref={scrollContainer} onScroll={handleScroll} class="h-full overflow-y-auto p-2 space-y-1">
        <div class="text-xs text-gray-400 font-mono px-2 py-1">{sessionId()}</div>
        <For each={messages()}>
          {(msg) => (
            <Show when={msg.type === "user" || msg.type === "assistant"}>
              <Show
                when={!isToolOnlyMessage(msg)}
                fallback={
                  <div class="px-2">
                    <For each={getContentBlocks(msg)}>
                      {(block) => <ContentBlockRenderer block={block} />}
                    </For>
                  </div>
                }
              >
                <div class={`p-3 rounded ${msg.type === "user" ? "bg-blue-50 ml-12" : "bg-gray-50"}`}>
                  <Show when={hasTextContent(msg)}>
                    <div class="text-xs font-medium text-gray-400 mb-1 uppercase">{msg.type}</div>
                  </Show>
                  <For each={getContentBlocks(msg)}>
                    {(block) => <ContentBlockRenderer block={block} />}
                  </For>
                </div>
              </Show>
            </Show>
          )}
        </For>
      </main>
      <Show when={!isAttachedToBottom()}>
        <button
          onClick={handleScrollToBottom}
          class="absolute bottom-4 right-6 bg-gray-800 text-white px-3 py-2 rounded-full shadow-lg hover:bg-gray-700 transition-colors flex items-center gap-2 text-sm"
        >
          <span>↓</span>
          <span>Latest</span>
        </button>
      </Show>
    </div>
  )
}

// ============================================================================
// App
// ============================================================================

function App() {
  return <RouterProvider router={router} />
}

render(() => <App />, document.getElementById("app")!)
