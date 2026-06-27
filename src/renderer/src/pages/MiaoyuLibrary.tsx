import { useEffect, useMemo, useRef, useState } from 'react'
import TopBar from '../components/TopBar'
import { ModalShell, ModalButton } from './homework/shared'

/**
 * 妙语库 —— 收藏群里高明/好玩的发言，借鉴学习「怎么幽默地说话」。
 *
 * 一条「帖子」= 文字 + 图片（截图）—— 还原原始语境（比如有人发张种田游戏图问
 * 「这干嘛的」）。帖子下挂多条「评论」，每条 = 评论文字（神回复，如「偷群友的菜」）
 * + 一段「思考」（为什么这么说好笑/高明）。思考是核心学习点，样式上区别于评论
 * 单独突出。
 *
 * 存储：结构/文字走 localStorage；图片走本地文件（userData/miaoyu-images），数据里
 * 只存 {hash, ext}，显示时用 miaoyuApi.imagesBase 拼 archivist:// URL（不持久化机器
 * 绝对路径）。坚果云同步留待下一步（数据模型已为同步预留 updatedAt）。
 */

interface MiaoyuImage { hash: string; ext: string }
interface MiaoyuComment {
  id: string
  text: string      // 评论文字（神回复）
  thought: string   // 思考（为什么好笑/高明）
  createdAt: number
  updatedAt: number
}
interface MiaoyuPost {
  id: string
  text: string             // 帖子文字（可空）
  images: MiaoyuImage[]
  comments: MiaoyuComment[]
  createdAt: number
  updatedAt: number
}

const STORAGE_KEY = 'maple-miaoyu-data-v1'

const uid = (): string => Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
const now = (): number => Date.now()

function fmtDate(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 兜底归一化 —— 缺字段补默认，丢弃明显非法项（zero-migration 向后兼容）。 */
function normalize(raw: unknown): MiaoyuPost[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((p): MiaoyuPost | null => {
      if (!p || typeof p !== 'object') return null
      const o = p as Record<string, unknown>
      const images = Array.isArray(o.images)
        ? (o.images as unknown[])
            .map((im) => {
              const i = im as Record<string, unknown>
              return i && typeof i.hash === 'string' && typeof i.ext === 'string'
                ? { hash: i.hash, ext: i.ext }
                : null
            })
            .filter((x): x is MiaoyuImage => x !== null)
        : []
      const comments = Array.isArray(o.comments)
        ? (o.comments as unknown[])
            .map((c): MiaoyuComment | null => {
              const cc = c as Record<string, unknown>
              if (!cc || typeof cc.text !== 'string') return null
              return {
                id: typeof cc.id === 'string' ? cc.id : uid(),
                text: cc.text,
                thought: typeof cc.thought === 'string' ? cc.thought : '',
                createdAt: typeof cc.createdAt === 'number' ? cc.createdAt : now(),
                updatedAt: typeof cc.updatedAt === 'number' ? cc.updatedAt : now(),
              }
            })
            .filter((x): x is MiaoyuComment => x !== null)
        : []
      return {
        id: typeof o.id === 'string' ? o.id : uid(),
        text: typeof o.text === 'string' ? o.text : '',
        images,
        comments,
        createdAt: typeof o.createdAt === 'number' ? o.createdAt : now(),
        updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : now(),
      }
    })
    .filter((x): x is MiaoyuPost => x !== null)
}

function readPosts(): MiaoyuPost[] {
  try {
    return normalize(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'))
  } catch {
    return []
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(new Error('读取图片失败'))
    r.readAsDataURL(blob)
  })
}

export default function MiaoyuLibrary(): JSX.Element {
  const [posts, setPosts] = useState<MiaoyuPost[]>(readPosts)
  const [imgBase, setImgBase] = useState('')

  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 弹窗状态
  const [postModal, setPostModal] = useState<{ mode: 'add' } | { mode: 'edit'; post: MiaoyuPost } | null>(null)
  const [commentModal, setCommentModal] = useState<{ postId: string; comment?: MiaoyuComment } | null>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)

  useEffect(() => { window.miaoyuApi.imagesBase().then(setImgBase).catch(() => {}) }, [])
  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(posts)) }, [posts])

  const imgUrl = (img: MiaoyuImage): string => `${imgBase}/${img.hash}.${img.ext}`

  const handleQuery = (v: string): void => {
    setQuery(v)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setDebouncedQuery(v.trim().toLowerCase()), 220)
  }

  // ── CRUD ────────────────────────────────────────────────────────────────
  const savePost = (text: string, images: MiaoyuImage[]): void => {
    if (postModal?.mode === 'edit') {
      const id = postModal.post.id
      setPosts((prev) => prev.map((p) => (p.id === id ? { ...p, text, images, updatedAt: now() } : p)))
    } else {
      const ts = now()
      setPosts((prev) => [{ id: uid(), text, images, comments: [], createdAt: ts, updatedAt: ts }, ...prev])
    }
    setPostModal(null)
  }

  const deletePost = (id: string): void => setPosts((prev) => prev.filter((p) => p.id !== id))

  const saveComment = (postId: string, text: string, thought: string, commentId?: string): void => {
    setPosts((prev) =>
      prev.map((p) => {
        if (p.id !== postId) return p
        const ts = now()
        if (commentId) {
          return {
            ...p,
            updatedAt: ts,
            comments: p.comments.map((c) => (c.id === commentId ? { ...c, text, thought, updatedAt: ts } : c)),
          }
        }
        return { ...p, updatedAt: ts, comments: [...p.comments, { id: uid(), text, thought, createdAt: ts, updatedAt: ts }] }
      }),
    )
    setCommentModal(null)
  }

  const deleteComment = (postId: string, commentId: string): void => {
    setPosts((prev) =>
      prev.map((p) =>
        p.id === postId ? { ...p, updatedAt: now(), comments: p.comments.filter((c) => c.id !== commentId) } : p,
      ),
    )
  }

  // ── 搜索过滤（帖子文字 / 评论 / 思考 任一命中） ──────────────────────────
  const filtered = useMemo(() => {
    if (!debouncedQuery) return posts
    return posts.filter(
      (p) =>
        p.text.toLowerCase().includes(debouncedQuery) ||
        p.comments.some(
          (c) => c.text.toLowerCase().includes(debouncedQuery) || c.thought.toLowerCase().includes(debouncedQuery),
        ),
    )
  }, [posts, debouncedQuery])

  const totalComments = useMemo(() => posts.reduce((s, p) => s + p.comments.length, 0), [posts])

  return (
    <div className="relative min-h-full bg-background">
      <TopBar
        placeholder=""
        titleSlot={
          <div className="flex items-center gap-4">
            <h2 className="text-2xl font-bold tracking-tighter text-primary">妙语库</h2>
            <span className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/60 hidden lg:inline">
              Witty Replies
            </span>
          </div>
        }
      />
      <div className="pt-16">
        {/* Sticky 页头 —— 同锦囊妙计：top-16 卡在 fixed TopBar 下面 */}
        <div className="sticky top-16 z-30 bg-surface-container-lowest border-b border-outline-variant/10 px-4 md:px-8 py-4 md:py-5">
          <div className="flex items-end justify-between gap-4 md:gap-6 flex-wrap">
            <div>
              <div className="hidden md:flex items-center gap-2 mb-2 text-xs font-label text-outline uppercase tracking-widest">
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>forum</span>
                <span>Social</span>
                <span className="text-outline-variant">/</span>
                <span className="text-on-surface font-bold">妙语库</span>
              </div>
              <h1 className="text-2xl md:text-3xl font-black tracking-tighter text-on-surface">妙语库</h1>
              <p className="hidden md:block text-sm text-on-surface-variant/80 mt-1 font-label">
                {posts.length} 帖 · {totalComments} 条妙语 —— 借鉴群友怎么幽默地说话
              </p>
            </div>

            <div className="flex items-center gap-2 md:gap-3 w-full md:w-auto">
              <div className="relative flex-1 md:flex-none">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-base">search</span>
                <input
                  spellCheck={false}
                  autoComplete="off"
                  className="w-full md:w-[320px] bg-surface-container-high border border-outline-variant/20 rounded-xl py-2.5 pl-10 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/40 focus:bg-surface-bright transition-all placeholder:text-on-surface-variant/40"
                  placeholder="搜索发言 / 思考…"
                  value={query}
                  onChange={(e) => handleQuery(e.target.value)}
                />
                {query && (
                  <button
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant/60 hover:text-primary p-1"
                    onClick={() => { setQuery(''); setDebouncedQuery('') }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 18 }}>close</span>
                  </button>
                )}
              </div>
              <button
                onClick={() => setPostModal({ mode: 'add' })}
                title="添加帖子"
                className="shrink-0 flex items-center gap-2 px-3.5 sm:px-5 py-2.5 rounded-xl bg-primary text-on-primary font-label text-xs uppercase tracking-widest hover:bg-primary-fixed transition-all active:scale-95 shadow-lg shadow-primary/10 whitespace-nowrap"
              >
                <span className="material-symbols-outlined" style={{ fontSize: 18, fontVariationSettings: "'FILL' 1" }}>add</span>
                <span className="hidden sm:inline">添加帖子</span>
              </button>
            </div>
          </div>
        </div>

        {/* 帖子流 */}
        {filtered.length === 0 ? (
          <EmptyState hasQuery={!!debouncedQuery} onAdd={() => setPostModal({ mode: 'add' })} />
        ) : (
          <div className="max-w-3xl mx-auto px-4 md:px-8 py-6 space-y-5">
            {filtered.map((post) => (
              <PostCard
                key={post.id}
                post={post}
                imgUrl={imgUrl}
                onEditPost={() => setPostModal({ mode: 'edit', post })}
                onDeletePost={() => deletePost(post.id)}
                onAddComment={() => setCommentModal({ postId: post.id })}
                onEditComment={(comment) => setCommentModal({ postId: post.id, comment })}
                onDeleteComment={(commentId) => deleteComment(post.id, commentId)}
                onOpenImage={setLightbox}
              />
            ))}
          </div>
        )}
      </div>

      {postModal && (
        <PostModal
          initial={postModal.mode === 'edit' ? postModal.post : null}
          imgUrl={imgUrl}
          onClose={() => setPostModal(null)}
          onSave={savePost}
          onPreview={setLightbox}
        />
      )}
      {commentModal && (
        <CommentModal
          initial={commentModal.comment ?? null}
          onClose={() => setCommentModal(null)}
          onSave={(text, thought) => saveComment(commentModal.postId, text, thought, commentModal.comment?.id)}
        />
      )}
      {lightbox && <Lightbox url={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  )
}

// ── Post card ─────────────────────────────────────────────────────────────
function PostCard({
  post, imgUrl, onEditPost, onDeletePost, onAddComment, onEditComment, onDeleteComment, onOpenImage,
}: {
  post: MiaoyuPost
  imgUrl: (img: MiaoyuImage) => string
  onEditPost: () => void
  onDeletePost: () => void
  onAddComment: () => void
  onEditComment: (c: MiaoyuComment) => void
  onDeleteComment: (id: string) => void
  onOpenImage: (url: string) => void
}): JSX.Element {
  const [confirmDel, setConfirmDel] = useState(false)
  const [showComments, setShowComments] = useState(false)
  return (
    <div className="bg-surface-container-lowest rounded-xl border border-white/5 overflow-hidden">
      {/* 帖子主体 —— B站式：顶部元信息，正文在上，图片在下 */}
      <div className="p-4 sm:p-5">
        {/* 顶部：日期 + 管理操作 */}
        <div className="flex items-center justify-between gap-3 mb-2.5">
          <div className="flex items-center gap-2 text-on-surface-variant/45">
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>forum</span>
            <span className="font-label text-[11px] tracking-wide">{fmtDate(post.createdAt)}</span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={onEditPost} title="编辑帖子" className="p-1.5 rounded-md text-on-surface-variant/60 hover:text-primary hover:bg-surface-container-high transition-colors">
              <span className="material-symbols-outlined" style={{ fontSize: 17 }}>edit</span>
            </button>
            {confirmDel ? (
              <button onClick={onDeletePost} title="确认删除整帖" className="p-1.5 rounded-md text-error bg-error/10 transition-colors" onMouseLeave={() => setConfirmDel(false)}>
                <span className="material-symbols-outlined" style={{ fontSize: 17 }}>delete_forever</span>
              </button>
            ) : (
              <button onClick={() => setConfirmDel(true)} title="删除整帖" className="p-1.5 rounded-md text-on-surface-variant/60 hover:text-error hover:bg-error/10 transition-colors">
                <span className="material-symbols-outlined" style={{ fontSize: 17 }}>delete</span>
              </button>
            )}
          </div>
        </div>

        {/* 正文 */}
        {post.text && (
          <p className="text-[15px] leading-relaxed text-on-surface whitespace-pre-wrap break-words">{post.text}</p>
        )}

        {/* 图片 —— 单图按原比例展示(限高 380)，多图走方格；都可点开大图预览 */}
        {post.images.length > 0 && (
          <div className="mt-3">
            {post.images.length === 1 ? (
              <button
                onClick={() => onOpenImage(imgUrl(post.images[0]))}
                title="点击预览"
                className="group relative inline-block align-top rounded-xl overflow-hidden border border-white/5 bg-surface-container-high"
              >
                <img src={imgUrl(post.images[0])} alt="" loading="lazy" className="block w-auto h-auto max-w-full md:max-w-[440px] max-h-[380px]" />
                <span className="absolute top-2 right-2 w-7 h-7 rounded-lg bg-black/35 backdrop-blur-sm text-white/0 group-hover:text-white/90 flex items-center justify-center transition-colors">
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>zoom_in</span>
                </span>
              </button>
            ) : (
              <div className="grid grid-cols-3 gap-2 max-w-full sm:max-w-[440px]">
                {post.images.map((img) => (
                  <button
                    key={img.hash}
                    onClick={() => onOpenImage(imgUrl(img))}
                    title="点击预览"
                    className="group relative aspect-square rounded-lg overflow-hidden bg-surface-container-high border border-white/5"
                  >
                    <img src={imgUrl(img)} alt="" loading="lazy" className="w-full h-full object-cover group-hover:scale-[1.05] transition-transform" />
                    <span className="absolute inset-0 bg-black/0 group-hover:bg-black/25 transition-colors flex items-center justify-center">
                      <span className="material-symbols-outlined text-white/0 group-hover:text-white/90 transition-colors" style={{ fontSize: 18 }}>zoom_in</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 妙语区 —— B站式：默认收起，点「N 条妙语」在下方展开；展开后顶部是写妙语入口。
         不做点赞/回复(本功能用不到)，仅保留编辑/删除管理。 */}
      <div className="border-t border-white/[0.04]">
        {post.comments.length === 0 ? (
          <button
            onClick={onAddComment}
            className="w-full flex items-center gap-2 px-4 sm:px-5 py-3 text-[13px] font-label text-secondary hover:bg-surface-container-low/40 transition-colors"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>add_comment</span>
            添加妙语
          </button>
        ) : (
          <>
            <button
              onClick={() => setShowComments((v) => !v)}
              className="w-full flex items-center gap-2 px-4 sm:px-5 py-3 text-[13px] font-medium text-on-surface-variant/80 hover:bg-surface-container-low/40 transition-colors"
            >
              <span className="material-symbols-outlined text-on-surface-variant/60" style={{ fontSize: 18 }}>mode_comment</span>
              <span>{post.comments.length} 条妙语</span>
              <span className={`material-symbols-outlined ml-auto text-on-surface-variant/50 transition-transform ${showComments ? 'rotate-180' : ''}`} style={{ fontSize: 20 }}>expand_more</span>
            </button>
            {showComments && (
              <div className="px-4 sm:px-5 pb-4 pt-1 space-y-2.5 bg-surface-container-low/20">
                {/* 写妙语入口 —— 置顶，仿 B站评论框 */}
                <button
                  onClick={onAddComment}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl bg-surface-container-high/50 border border-outline-variant/10 text-on-surface-variant/45 hover:border-primary/30 hover:text-primary transition-colors text-left"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 18 }}>add_comment</span>
                  <span className="text-sm font-label">添加一条妙语…</span>
                </button>
                {post.comments.map((c) => (
                  <CommentItem key={c.id} comment={c} onEdit={() => onEditComment(c)} onDelete={() => onDeleteComment(c.id)} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function CommentItem({ comment, onEdit, onDelete }: { comment: MiaoyuComment; onEdit: () => void; onDelete: () => void }): JSX.Element {
  const [confirmDel, setConfirmDel] = useState(false)
  return (
    <div className="group relative rounded-xl bg-surface-container-high/40 border border-outline-variant/10 hover:border-primary/25 transition-colors overflow-hidden">
      {/* 神回复正文 —— 用 on-surface 而非 primary，读起来像内容不像链接；引号作主色点缀 */}
      <div className="flex items-start gap-2.5 px-3.5 py-2.5">
        <span className="material-symbols-outlined text-primary/55 shrink-0 mt-0.5" style={{ fontSize: 18, fontVariationSettings: "'FILL' 1" }}>format_quote</span>
        <p className="flex-1 min-w-0 text-[15px] font-semibold text-on-surface leading-snug whitespace-pre-wrap break-words">{comment.text}</p>
        {/* 操作 —— hover 显现 */}
        <div className="flex items-center gap-0.5 shrink-0 -mr-1 -mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button onClick={onEdit} title="编辑妙语" className="p-1 rounded text-on-surface-variant/50 hover:text-primary hover:bg-surface-container-high transition-colors">
            <span className="material-symbols-outlined" style={{ fontSize: 15 }}>edit</span>
          </button>
          {confirmDel ? (
            <button onClick={onDelete} title="确认删除" onMouseLeave={() => setConfirmDel(false)} className="p-1 rounded text-error bg-error/10">
              <span className="material-symbols-outlined" style={{ fontSize: 15 }}>delete_forever</span>
            </button>
          ) : (
            <button onClick={() => setConfirmDel(true)} title="删除妙语" className="p-1 rounded text-on-surface-variant/50 hover:text-error hover:bg-error/10 transition-colors">
              <span className="material-symbols-outlined" style={{ fontSize: 15 }}>delete</span>
            </button>
          )}
        </div>
      </div>
      {/* 思考 —— 底部淡色注脚条，灯泡 + 内联「思考」标签，不再用大色块 */}
      {comment.thought && (
        <div className="flex items-start gap-2 px-3.5 py-2.5 bg-tertiary/[0.06] border-t border-tertiary/10">
          <span className="material-symbols-outlined text-tertiary/70 shrink-0 mt-[3px]" style={{ fontSize: 14 }}>lightbulb</span>
          <p className="flex-1 min-w-0 text-[13px] leading-relaxed text-on-surface-variant/80 whitespace-pre-wrap break-words">
            <span className="font-label text-[10px] uppercase tracking-wider text-tertiary/70 mr-2">思考</span>
            {comment.thought}
          </p>
        </div>
      )}
    </div>
  )
}

// ── Post modal (add / edit) ─────────────────────────────────────────────────
function PostModal({
  initial, imgUrl, onClose, onSave, onPreview,
}: {
  initial: MiaoyuPost | null
  imgUrl: (img: MiaoyuImage) => string
  onClose: () => void
  onSave: (text: string, images: MiaoyuImage[]) => void
  onPreview: (url: string) => void
}): JSX.Element {
  const [text, setText] = useState(initial?.text ?? '')
  const [images, setImages] = useState<MiaoyuImage[]>(initial?.images ?? [])
  const [uploading, setUploading] = useState(false)
  const [err, setErr] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  // 拖拽态用计数器消抖：拖过子元素会反复触发 enter/leave，靠进出计数判断真正离开
  const dragDepth = useRef(0)

  // 弹窗打开期间，拦掉窗口级的文件拖放默认行为 —— 否则把图片拖进来时 Electron
  // 会把整个窗口导航到 file://，SPA 被冲掉。只在本弹窗存活期挂这对监听。
  useEffect(() => {
    const prevent = (e: DragEvent): void => e.preventDefault()
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    return () => {
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
    }
  }, [])

  const addFiles = async (files: Blob[]): Promise<void> => {
    if (!files.length) return
    setUploading(true)
    setErr('')
    try {
      const added: MiaoyuImage[] = []
      for (const f of files) {
        const dataUrl = await blobToDataUrl(f)
        added.push(await window.miaoyuApi.saveImage(dataUrl))
      }
      // 去重（同图 hash 一致）
      setImages((prev) => {
        const seen = new Set(prev.map((i) => i.hash))
        return [...prev, ...added.filter((i) => !seen.has(i.hash))]
      })
    } catch {
      setErr('图片处理失败，换一张试试')
    } finally {
      setUploading(false)
    }
  }

  const onPaste = (e: React.ClipboardEvent): void => {
    const items = e.clipboardData?.items
    if (!items) return
    const imgs: Blob[] = []
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      if (it.type.startsWith('image/')) {
        const f = it.getAsFile()
        if (f) imgs.push(f)
      }
    }
    if (imgs.length) { e.preventDefault(); void addFiles(imgs) }
  }

  // 从浏览器拖图常常只给一个 URL（没有 File），尝试抓取成 Blob 再入库
  const addRemoteUrl = async (url: string): Promise<void> => {
    setUploading(true)
    setErr('')
    try {
      const res = await fetch(url)
      const blob = await res.blob()
      if (!blob.type.startsWith('image/')) throw new Error('not image')
      await addFiles([blob])
    } catch {
      setErr('网络图片拖拽抓取失败，可改用粘贴或先保存再选图')
    } finally {
      setUploading(false)
    }
  }

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    dragDepth.current = 0
    setDragOver(false)
    const dt = e.dataTransfer
    // 同步收集 —— DataTransfer 在事件回调结束后即失效，不能放进 await 之后再读
    const files = Array.from(dt.files).filter((f) => f.type.startsWith('image/'))
    if (!files.length) {
      for (let i = 0; i < dt.items.length; i++) {
        const it = dt.items[i]
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          const f = it.getAsFile()
          if (f) files.push(f)
        }
      }
    }
    if (files.length) { void addFiles(files); return }
    const uri = (dt.getData('text/uri-list') || dt.getData('text/plain') || '').trim()
    if (/^https?:\/\//i.test(uri)) void addRemoteUrl(uri)
  }

  const onDragEnter = (e: React.DragEvent): void => {
    e.preventDefault()
    dragDepth.current += 1
    setDragOver(true)
  }
  const onDragOver = (e: React.DragEvent): void => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  const onDragLeave = (): void => {
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragOver(false)
  }

  const canSave = (text.trim().length > 0 || images.length > 0) && !uploading

  return (
    <ModalShell onBackdrop={onClose}>
      <div
        onPaste={onPaste}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className="relative"
      >
        {/* 拖拽悬停提示层：盖住整张卡片，pointer-events-none 让拖放事件照常冒泡到外层 */}
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 rounded-xl border-2 border-dashed border-primary/70 bg-primary/10 backdrop-blur-[1px] flex flex-col items-center justify-center gap-2">
            <span className="material-symbols-outlined text-primary text-4xl" style={{ fontVariationSettings: "'FILL' 1" }}>add_photo_alternate</span>
            <span className="font-label text-xs uppercase tracking-widest text-primary">松开以添加图片</span>
          </div>
        )}
        <div className="flex items-center gap-4 px-7 pt-6 pb-5 border-b border-outline-variant/10">
          <div className="w-11 h-11 rounded-xl bg-primary/15 border border-primary/25 flex items-center justify-center flex-shrink-0">
            <span className="material-symbols-outlined text-primary text-[22px]" style={{ fontVariationSettings: "'FILL' 1" }}>post_add</span>
          </div>
          <div>
            <h3 className="text-base font-black tracking-tight">{initial ? '编辑帖子' : '新增帖子'}</h3>
            <p className="text-[11px] text-on-surface-variant/60 mt-0.5 font-label">还原原始语境：发言 + 截图（可只发其一）</p>
          </div>
        </div>

        <div className="px-7 py-5 space-y-4 max-h-[60vh] overflow-y-auto custom-scrollbar">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
            rows={3}
            placeholder="帖子内容 / 原始语境，例：（一张种田游戏图）这干嘛的"
            className="w-full bg-surface-container-high border border-outline-variant/15 rounded-xl px-4 py-3 text-sm leading-relaxed resize-y focus:outline-none focus:border-primary/40 focus:ring-2 focus:ring-primary/30 placeholder:text-on-surface-variant/35"
          />

          {/* 图片区 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant/50">图片（可多张）</span>
              <span className="font-label text-[10px] text-on-surface-variant/35">支持 拖拽 / Ctrl·⌘+V 粘贴</span>
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
              {images.map((img) => (
                <div key={img.hash} className="relative aspect-square rounded-lg overflow-hidden bg-surface-container border border-white/5 group">
                  {/* 点图预览 —— 复用页面级 Lightbox（z-80 盖过弹窗） */}
                  <button onClick={() => onPreview(imgUrl(img))} title="预览" className="absolute inset-0 w-full h-full">
                    <img src={imgUrl(img)} alt="" className="w-full h-full object-cover" />
                    <span className="absolute inset-0 bg-black/0 group-hover:bg-black/25 transition-colors flex items-center justify-center">
                      <span className="material-symbols-outlined text-white/0 group-hover:text-white/90 transition-colors" style={{ fontSize: 20 }}>zoom_in</span>
                    </span>
                  </button>
                  <button
                    onClick={() => setImages((prev) => prev.filter((i) => i.hash !== img.hash))}
                    title="移除"
                    className="absolute top-1 right-1 z-10 w-6 h-6 rounded-md bg-black/55 hover:bg-error/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 15 }}>close</span>
                  </button>
                </div>
              ))}
              {/* 添加图片占位 */}
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="aspect-square rounded-lg border border-dashed border-outline-variant/30 text-on-surface-variant/45 hover:text-primary hover:border-primary/40 transition-colors flex flex-col items-center justify-center gap-1 disabled:opacity-50"
              >
                <span className="material-symbols-outlined" style={{ fontSize: 22 }}>{uploading ? 'progress_activity' : 'add_photo_alternate'}</span>
                <span className="font-label text-[9px] uppercase tracking-wider">{uploading ? '处理中' : '选图片'}</span>
              </button>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? [])
                e.target.value = ''
                void addFiles(files)
              }}
            />
            {err && <p className="mt-1.5 font-label text-[10px] text-error">{err}</p>}
          </div>
        </div>

        <div className="px-7 py-4 bg-surface-container/60 border-t border-outline-variant/10 rounded-b-xl flex items-center gap-3">
          <ModalButton variant="cancel" onClick={onClose}>取消</ModalButton>
          <ModalButton variant="primary" icon="save" disabled={!canSave} onClick={() => onSave(text.trim(), images)}>
            {initial ? '保存' : '发布'}
          </ModalButton>
        </div>
      </div>
    </ModalShell>
  )
}

// ── Comment modal (add / edit) ──────────────────────────────────────────────
function CommentModal({
  initial, onClose, onSave,
}: {
  initial: MiaoyuComment | null
  onClose: () => void
  onSave: (text: string, thought: string) => void
}): JSX.Element {
  const [text, setText] = useState(initial?.text ?? '')
  const [thought, setThought] = useState(initial?.thought ?? '')
  const canSave = text.trim().length > 0

  return (
    <ModalShell onBackdrop={onClose}>
      <div className="flex items-center gap-4 px-7 pt-6 pb-5 border-b border-outline-variant/10">
        <div className="w-11 h-11 rounded-xl bg-secondary/15 border border-secondary/25 flex items-center justify-center flex-shrink-0">
          <span className="material-symbols-outlined text-secondary text-[22px]" style={{ fontVariationSettings: "'FILL' 1" }}>format_quote</span>
        </div>
        <div>
          <h3 className="text-base font-black tracking-tight">{initial ? '编辑妙语' : '添加妙语'}</h3>
          <p className="text-[11px] text-on-surface-variant/60 mt-0.5 font-label">神回复 + 一段「为什么这么说高明」的思考</p>
        </div>
      </div>

      <div className="px-7 py-5 space-y-4">
        <div>
          <label className="flex items-center gap-1.5 font-label text-[10px] uppercase tracking-widest text-primary/80 mb-1.5">
            <span className="material-symbols-outlined" style={{ fontSize: 13 }}>chat</span>评论 / 神回复
          </label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
            rows={2}
            placeholder="例：偷群友的菜"
            className="w-full bg-surface-container-high border border-outline-variant/15 rounded-xl px-4 py-3 text-sm leading-relaxed resize-y focus:outline-none focus:border-primary/40 focus:ring-2 focus:ring-primary/30 placeholder:text-on-surface-variant/35"
          />
        </div>
        <div>
          <label className="flex items-center gap-1.5 font-label text-[10px] uppercase tracking-widest text-tertiary/80 mb-1.5">
            <span className="material-symbols-outlined" style={{ fontSize: 13 }}>lightbulb</span>思考（为什么好笑 / 高明）
          </label>
          <textarea
            value={thought}
            onChange={(e) => setThought(e.target.value)}
            rows={3}
            placeholder="例：明知故问的问题，诚实答「种田」无聊；「偷群友的菜」把日常游戏行为框成带点邪恶的玩笑，反差出幽默。"
            className="w-full bg-surface-container-high border border-outline-variant/15 rounded-xl px-4 py-3 text-sm leading-relaxed resize-y focus:outline-none focus:border-tertiary/40 focus:ring-2 focus:ring-tertiary/25 placeholder:text-on-surface-variant/35"
          />
        </div>
      </div>

      <div className="px-7 py-4 bg-surface-container/60 border-t border-outline-variant/10 rounded-b-xl flex items-center gap-3">
        <ModalButton variant="cancel" onClick={onClose}>取消</ModalButton>
        <ModalButton variant="primary" icon="save" disabled={!canSave} onClick={() => onSave(text.trim(), thought.trim())}>
          {initial ? '保存' : '添加'}
        </ModalButton>
      </div>
    </ModalShell>
  )
}

// ── Lightbox ────────────────────────────────────────────────────────────────
function Lightbox({ url, onClose }: { url: string; onClose: () => void }): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-[80] bg-black/85 backdrop-blur-sm flex items-center justify-center p-6 cursor-zoom-out" onClick={onClose}>
      <img src={url} alt="" className="max-w-full max-h-full object-contain rounded-lg shadow-2xl" onClick={(e) => e.stopPropagation()} />
      <button onClick={onClose} className="absolute top-5 right-5 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors">
        <span className="material-symbols-outlined">close</span>
      </button>
    </div>
  )
}

// ── Empty state ─────────────────────────────────────────────────────────────
function EmptyState({ hasQuery, onAdd }: { hasQuery: boolean; onAdd: () => void }): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center text-center py-24 px-6">
      <div className="w-16 h-16 rounded-2xl bg-surface-container-high flex items-center justify-center mb-4">
        <span className="material-symbols-outlined text-primary text-3xl">{hasQuery ? 'search_off' : 'forum'}</span>
      </div>
      <h3 className="text-lg font-bold text-on-surface">{hasQuery ? '没有匹配的妙语' : '妙语库还是空的'}</h3>
      <p className="text-sm text-on-surface-variant/70 mt-1 font-label max-w-sm leading-relaxed">
        {hasQuery
          ? '换个关键词试试。'
          : '把群里高明、好玩的发言收进来：一张截图 + 神回复 + 你的「思考」，慢慢练就一张会说话的嘴。'}
      </p>
      {!hasQuery && (
        <button
          onClick={onAdd}
          className="mt-5 flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-on-primary font-label text-xs uppercase tracking-widest hover:bg-primary-fixed transition-all active:scale-95"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 18, fontVariationSettings: "'FILL' 1" }}>add</span>
          添加第一帖
        </button>
      )}
    </div>
  )
}
