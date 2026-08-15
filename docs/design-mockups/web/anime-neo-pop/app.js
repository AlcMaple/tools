(() => {
  'use strict'

  const $ = (selector, root = document) => root.querySelector(selector)
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]

  const viewMeta = {
    calendar: 'WEEKLY BOARD · VOL. 06',
    tracks: 'PERSONAL WATCH DESK · VOL. 06',
    player: 'NOW SCREENING · PLAYER',
    settings: 'CONTROL ROOM · SETTINGS',
  }

  const statusLabels = {
    watching: '在追',
    plan: '想看',
    done: '看完',
  }

  let activeView = 'calendar'
  let activeTrackFilter = 'all'
  let activeEditTrack = null
  let activePlayerTrack = 'makeine'
  let activePlayerEpisode = 7
  let playerTotal = 12
  let playerIsPlaying = false
  let toastTimer = 0
  let previousFocus = null

  const tracks = new Map()

  $$('[data-track]').forEach((card) => {
    tracks.set(card.dataset.track, {
      id: card.dataset.track,
      card,
      title: $('h2', card)?.textContent.trim() || '未命名番剧',
      subtitle: $('.track-body > p', card)?.textContent.trim() || '',
      status: card.dataset.status,
      episode: Number.parseInt(card.dataset.episode || '0', 10),
      total: card.dataset.total === '' ? null : Number.parseInt(card.dataset.total, 10),
      added: card.dataset.added === 'true',
      poster: card.dataset.poster || 'a',
    })
  })

  function showToast(message) {
    const toast = $('#toast')
    const label = $('#toast-message')
    if (!toast || !label) return

    window.clearTimeout(toastTimer)
    label.textContent = message
    toast.classList.add('is-visible')
    toast.setAttribute('aria-hidden', 'false')
    toastTimer = window.setTimeout(() => {
      toast.classList.remove('is-visible')
      toast.setAttribute('aria-hidden', 'true')
    }, 2600)
  }

  function switchView(nextView, options = {}) {
    if (!viewMeta[nextView]) return
    activeView = nextView

    $$('[data-view-panel]').forEach((panel) => {
      const selected = panel.dataset.viewPanel === nextView
      panel.hidden = !selected
      panel.classList.toggle('is-active', selected)
    })

    $$('[data-view]').forEach((button) => {
      const selected = button.dataset.view === nextView
      button.classList.toggle('is-active', selected)
      if (selected) button.setAttribute('aria-current', 'page')
      else button.removeAttribute('aria-current')
    })

    $('#view-kicker').textContent = viewMeta[nextView]
    window.history.replaceState(null, '', `#${nextView}`)

    if (!options.keepScroll) {
      window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    }
  }

  $$('[data-view]').forEach((button) => {
    button.addEventListener('click', () => switchView(button.dataset.view))
  })

  $$('[data-view-link]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault()
      switchView(link.dataset.viewLink)
    })
  })

  const requestedView = location.hash.replace('#', '')
  if (viewMeta[requestedView]) switchView(requestedView, { keepScroll: true })

  $$('.day-chip').forEach((button) => {
    button.addEventListener('click', () => {
      const selectedDay = button.dataset.day
      let count = 0

      $$('.day-chip').forEach((chip) => {
        const selected = chip === button
        chip.classList.toggle('is-active', selected)
        chip.setAttribute('aria-pressed', String(selected))
      })

      $$('[data-calendar-card]').forEach((card) => {
        const visible = selectedDay === 'all' || card.dataset.day === selectedDay
        card.hidden = !visible
        if (visible) count += 1
      })

      $('#calendar-count').textContent = String(count)
      const label = $('strong', button)?.textContent || '全部'
      showToast(`${label === '全部' ? '整周' : `星期${label}`} · ${count} 部番剧`)
    })
  })

  $$('[data-follow]').forEach((button) => {
    button.addEventListener('click', () => {
      const following = button.getAttribute('aria-pressed') === 'true'
      button.setAttribute('aria-pressed', String(!following))
      button.classList.toggle('is-following', !following)
      $('span', button).textContent = following ? '＋' : '✓'
      $('strong', button).textContent = following ? '追番' : '已追番'
      const title = $('h3', button.closest('.anime-card'))?.textContent || '该番剧'
      showToast(following ? `已从追番中移除「${title}」` : `已加入追番「${title}」`)
    })
  })

  function updateTrackCard(track) {
    const { card } = track
    card.dataset.status = track.status
    card.dataset.episode = String(track.episode)
    card.dataset.total = track.total == null ? '' : String(track.total)
    card.dataset.added = String(track.added)

    const status = $('[data-status-label]', card)
    const episode = $('[data-episode-value]', card)
    const total = $('[data-total-value]', card)
    const decrease = $('[data-step="-1"]', card)
    const increase = $('[data-step="1"]', card)
    const continueCopy = $('[data-continue] span:last-child', card)

    if (status) status.textContent = statusLabels[track.status]
    if (episode) episode.textContent = String(track.episode)
    if (total) total.textContent = track.total == null ? '连载中' : String(track.total)
    if (decrease) decrease.disabled = track.episode <= 0
    if (increase) increase.disabled = track.total != null && track.episode >= track.total

    if (continueCopy) {
      if (track.status === 'done' && track.episode > 0) continueCopy.textContent = `重温 EP.${track.episode}`
      else if (track.episode <= 0) continueCopy.textContent = '从 EP.1 开始'
      else continueCopy.textContent = `继续看 EP.${track.episode}`
    }

    if (activeEditTrack === track.id) syncEditModal(track)
  }

  function updateCounts() {
    const counts = { all: 0, watching: 0, plan: 0, done: 0 }
    tracks.forEach((track) => {
      if (!track.added) return
      counts.all += 1
      counts[track.status] += 1
    })

    Object.entries(counts).forEach(([key, value]) => {
      const node = $(`[data-count="${key}"]`)
      if (node) node.textContent = String(value)
    })
  }

  function updateTrackVisibility() {
    const query = $('#track-search').value.trim().toLocaleLowerCase('zh-Hans')
    let visibleCount = 0

    tracks.forEach((track) => {
      const matchesStatus = activeTrackFilter === 'all' || track.status === activeTrackFilter
      const matchesQuery = !query || track.card.dataset.title.toLocaleLowerCase('zh-Hans').includes(query)
      const visible = track.added && matchesStatus && matchesQuery
      track.card.hidden = !visible
      if (visible) visibleCount += 1
    })

    $('#track-result-count').textContent = `${visibleCount} 部`
    $('#track-grid').hidden = visibleCount === 0
    $('#track-empty').hidden = visibleCount !== 0
  }

  function setTrackStatus(track, nextStatus) {
    if (!statusLabels[nextStatus] || track.status === nextStatus) return
    track.status = nextStatus
    updateTrackCard(track)
    updateCounts()
    updateTrackVisibility()
  }

  function stepTrack(track, delta, announce = true) {
    const previousEpisode = track.episode
    let nextEpisode = Math.max(0, previousEpisode + delta)
    if (track.total != null) nextEpisode = Math.min(track.total, nextEpisode)
    if (nextEpisode === previousEpisode) return

    track.episode = nextEpisode
    if (delta > 0 && nextEpisode > 0 && track.status === 'plan') {
      track.status = 'watching'
      if (announce) showToast(`已从“想看”转为“在追” · EP.${nextEpisode}`)
    } else if (announce) {
      showToast(`观看进度已更新为 EP.${nextEpisode}`)
    }

    updateTrackCard(track)
    updateCounts()
    updateTrackVisibility()
  }

  $$('.status-chip').forEach((button) => {
    button.addEventListener('click', () => {
      activeTrackFilter = button.dataset.trackFilter
      $$('.status-chip').forEach((chip) => {
        const selected = chip === button
        chip.classList.toggle('is-active', selected)
        chip.setAttribute('aria-pressed', String(selected))
      })
      updateTrackVisibility()
    })
  })

  $('#track-search').addEventListener('input', updateTrackVisibility)

  $('[data-clear-track-filter]').addEventListener('click', () => {
    activeTrackFilter = 'all'
    $('#track-search').value = ''
    $$('.status-chip').forEach((chip) => {
      const selected = chip.dataset.trackFilter === 'all'
      chip.classList.toggle('is-active', selected)
      chip.setAttribute('aria-pressed', String(selected))
    })
    updateTrackVisibility()
  })

  $('#track-grid').addEventListener('click', (event) => {
    const stepButton = event.target.closest('[data-step]')
    if (stepButton) {
      const card = stepButton.closest('[data-track]')
      const track = tracks.get(card?.dataset.track)
      if (track) stepTrack(track, Number(stepButton.dataset.step))
      return
    }

    const editButton = event.target.closest('[data-edit-track]')
    if (editButton) {
      const track = tracks.get(editButton.dataset.editTrack)
      if (track) openEditModal(track)
      return
    }

    const continueButton = event.target.closest('[data-continue]')
    if (continueButton) {
      const track = tracks.get(continueButton.dataset.continue)
      if (track) openPlayer(track)
    }
  })

  function syncEditModal(track) {
    $('#edit-modal-title').textContent = track.title
    $('#edit-modal-subtitle').textContent = track.subtitle
    $('#edit-episode').textContent = String(track.episode)
    $('#edit-total').value = track.total == null ? '' : String(track.total)

    const poster = $('#edit-poster')
    poster.className = `mini-poster poster-${track.poster}`
    poster.innerHTML = '<span>EDIT</span>'

    $$('[data-edit-status]').forEach((button) => {
      const selected = button.dataset.editStatus === track.status
      button.classList.toggle('is-active', selected)
      button.setAttribute('aria-pressed', String(selected))
    })

    $('[data-edit-step="-1"]').disabled = track.episode <= 0
    $('[data-edit-step="1"]').disabled = track.total != null && track.episode >= track.total
  }

  function openEditModal(track) {
    activeEditTrack = track.id
    syncEditModal(track)
    const tags = $$('.tag-row span', track.card).map((tag) => tag.textContent)
    $('#edit-tags').innerHTML = ''
    tags.forEach((tag) => appendEditTag(tag))
    openModal($('#edit-modal'), $('[data-edit-status].is-active'))
  }

  $$('[data-edit-status]').forEach((button) => {
    button.addEventListener('click', () => {
      const track = tracks.get(activeEditTrack)
      if (!track) return
      setTrackStatus(track, button.dataset.editStatus)
      showToast(`「${track.title}」已设为${statusLabels[track.status]}`)
    })
  })

  $$('[data-edit-step]').forEach((button) => {
    button.addEventListener('click', () => {
      const track = tracks.get(activeEditTrack)
      if (track) stepTrack(track, Number(button.dataset.editStep))
    })
  })

  $('#edit-total').addEventListener('input', (event) => {
    event.target.value = event.target.value.replace(/\D/g, '')
  })

  $('#edit-total').addEventListener('change', (event) => {
    const track = tracks.get(activeEditTrack)
    if (!track) return
    const raw = event.target.value.trim()
    const nextTotal = raw === '' ? null : Math.max(1, Number.parseInt(raw, 10))
    track.total = Number.isFinite(nextTotal) ? nextTotal : null
    if (track.total != null) track.episode = Math.min(track.episode, track.total)
    updateTrackCard(track)
    showToast(track.total == null ? '已设为连载中' : `总集数已更新为 ${track.total}`)
  })

  function appendEditTag(tag) {
    const value = tag.trim()
    if (!value) return
    const chip = document.createElement('span')
    chip.textContent = value
    $('#edit-tags').append(chip)
  }

  $('#add-tag-button').addEventListener('click', () => {
    const input = $('#edit-tag-input')
    const value = input.value.trim()
    if (!value) return
    const existing = $$('.edit-tags span').some((chip) => chip.textContent === value)
    if (!existing) appendEditTag(value)
    input.value = ''
    showToast(`已添加标签“${value}”`)
  })

  $('#edit-tag-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      $('#add-tag-button').click()
    }
  })

  function openPlayer(track) {
    activePlayerTrack = track.id
    activePlayerEpisode = track.episode > 0 ? track.episode : 1
    playerTotal = track.total || 12
    playerIsPlaying = false

    $('#player-title').textContent = track.title
    $('#player-subtitle').textContent = `${track.subtitle} · EP.${activePlayerEpisode}`
    const stage = $('#video-stage')
    stage.className = `video-stage poster-${track.poster}`
    stage.dataset.playing = 'false'
    updatePlayerState()
    renderEpisodeGrid()
    switchView('player')
  }

  function updatePlayerState() {
    $('#stage-episode').textContent = `EP.${String(activePlayerEpisode).padStart(2, '0')}`
    $('#stage-status').textContent = playerIsPlaying ? 'PLAYING / 正在播放' : 'PAUSED / 已暂停'
    $('#episode-selection').textContent = `EP.${activePlayerEpisode} / ${playerTotal}`
    $('#player-subtitle').textContent = `${tracks.get(activePlayerTrack)?.subtitle || ''} · EP.${activePlayerEpisode}`

    const playToggle = $('#play-toggle')
    const playControl = $('#play-control')
    $('#video-stage').dataset.playing = String(playerIsPlaying)
    playToggle.setAttribute('aria-pressed', String(playerIsPlaying))
    playToggle.setAttribute('aria-label', playerIsPlaying ? '暂停' : '播放')
    playControl.setAttribute('aria-pressed', String(playerIsPlaying))
    $('span', playControl).textContent = playerIsPlaying ? 'Ⅱ' : '▶'
    $('strong', playControl).textContent = playerIsPlaying ? '暂停' : '播放'

    $$('#episode-grid button').forEach((button) => {
      const selected = Number(button.dataset.episode) === activePlayerEpisode
      button.classList.toggle('is-active', selected)
      button.setAttribute('aria-pressed', String(selected))
    })
  }

  function renderEpisodeGrid() {
    const grid = $('#episode-grid')
    grid.innerHTML = ''
    const fragment = document.createDocumentFragment()

    for (let episode = 1; episode <= playerTotal; episode += 1) {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.episode = String(episode)
      button.textContent = String(episode).padStart(2, '0')
      button.setAttribute('aria-label', `第 ${episode} 集`)
      button.setAttribute('aria-pressed', String(episode === activePlayerEpisode))
      button.classList.toggle('is-active', episode === activePlayerEpisode)
      fragment.append(button)
    }

    grid.append(fragment)
  }

  function togglePlayer() {
    playerIsPlaying = !playerIsPlaying
    updatePlayerState()
    showToast(playerIsPlaying ? `正在播放 EP.${activePlayerEpisode}` : `已暂停在 EP.${activePlayerEpisode}`)
  }

  $('#play-toggle').addEventListener('click', togglePlayer)
  $('#play-control').addEventListener('click', togglePlayer)

  $('#episode-grid').addEventListener('click', (event) => {
    const button = event.target.closest('[data-episode]')
    if (!button) return
    activePlayerEpisode = Number(button.dataset.episode)
    playerIsPlaying = false
    updatePlayerState()
    showToast(`已选择第 ${activePlayerEpisode} 集`)
  })

  $$('[data-line]').forEach((button) => {
    button.addEventListener('click', () => {
      $$('[data-line]').forEach((line) => {
        const selected = line === button
        line.classList.toggle('is-active', selected)
        line.setAttribute('aria-pressed', String(selected))
      })
      showToast(`已切换到${button.textContent.trim()}`)
    })
  })

  function closeAllSelects(except = null) {
    $$('[data-select]').forEach((select) => {
      if (select === except) return
      const trigger = $('[data-select-trigger]', select)
      const menu = $('.select-menu', select)
      trigger.setAttribute('aria-expanded', 'false')
      menu.hidden = true
    })
  }

  $$('[data-select]').forEach((select) => {
    const trigger = $('[data-select-trigger]', select)
    const menu = $('.select-menu', select)

    trigger.addEventListener('click', () => {
      const willOpen = trigger.getAttribute('aria-expanded') !== 'true'
      closeAllSelects(select)
      trigger.setAttribute('aria-expanded', String(willOpen))
      menu.hidden = !willOpen
      if (willOpen) $('[role="option"]', menu)?.focus()
    })

    $$('[role="option"]', menu).forEach((option) => {
      option.addEventListener('click', () => {
        $$('[role="option"]', menu).forEach((item) => item.setAttribute('aria-selected', String(item === option)))
        $('[data-select-label]', trigger).textContent = option.dataset.value
        trigger.setAttribute('aria-expanded', 'false')
        menu.hidden = true
        trigger.focus()
        showToast(`已选择“${option.dataset.value}”`)
      })
    })
  })

  document.addEventListener('click', (event) => {
    if (!event.target.closest('[data-select]')) closeAllSelects()
  })

  $$('[data-settings-pane]').forEach((button) => {
    button.addEventListener('click', () => {
      const pane = button.dataset.settingsPane
      $$('[data-settings-pane]').forEach((tab) => {
        const selected = tab === button
        tab.classList.toggle('is-active', selected)
        tab.setAttribute('aria-selected', String(selected))
        tab.tabIndex = selected ? 0 : -1
      })
      $$('[data-settings-content]').forEach((content) => {
        const selected = content.dataset.settingsContent === pane
        content.hidden = !selected
        content.classList.toggle('is-active', selected)
      })
    })
  })

  $('[data-mock-sync]').addEventListener('click', (event) => {
    const button = event.currentTarget
    button.textContent = '同步完成 ✓'
    showToast('网页版追番记录已同步')
    window.setTimeout(() => {
      button.textContent = '立即同步'
    }, 2200)
  })

  function openModal(modal, focusTarget = null) {
    if (!modal) return
    previousFocus = document.activeElement
    modal.hidden = false
    document.body.classList.add('modal-open')
    window.requestAnimationFrame(() => {
      const target = focusTarget || $('input, button:not([data-modal-close])', modal) || $('.modal-close', modal)
      target?.focus()
    })
  }

  function closeModal(modal) {
    if (!modal || modal.hidden) return
    modal.hidden = true
    if (!$$('[data-modal]').some((item) => !item.hidden)) document.body.classList.remove('modal-open')
    previousFocus?.focus?.()
    previousFocus = null
  }

  $$('[data-modal]').forEach((modal) => {
    modal.addEventListener('mousedown', (event) => {
      if (event.target === modal) closeModal(modal)
    })
    $$('[data-modal-close]', modal).forEach((button) => button.addEventListener('click', () => closeModal(modal)))
  })

  $$('[data-open-add]').forEach((button) => {
    button.addEventListener('click', () => {
      $('#add-search').value = ''
      $$('[data-add-result]').forEach((result) => { result.hidden = false })
      $('#add-empty').hidden = true
      const shiunji = tracks.get('shiunji')
      const shiunjiButton = $('[data-add-track="shiunji"]')
      if (shiunji?.added) {
        shiunjiButton.textContent = '✓ 已加入'
        shiunjiButton.classList.add('is-added')
        shiunjiButton.disabled = true
      }
      openModal($('#add-modal'), $('#add-search'))
    })
  })

  $('#add-search').addEventListener('input', (event) => {
    const query = event.target.value.trim().toLocaleLowerCase('zh-Hans')
    let visible = 0
    $$('[data-add-result]').forEach((result) => {
      const matches = !query || result.dataset.search.toLocaleLowerCase('zh-Hans').includes(query)
      result.hidden = !matches
      if (matches) visible += 1
    })
    $('#add-empty').hidden = visible !== 0
  })

  $('[data-add-track="shiunji"]').addEventListener('click', (event) => {
    const track = tracks.get('shiunji')
    if (!track || track.added) return
    track.added = true
    updateTrackCard(track)
    updateCounts()
    updateTrackVisibility()
    event.currentTarget.textContent = '✓ 已加入'
    event.currentTarget.classList.add('is-added')
    event.currentTarget.disabled = true
    closeModal($('#add-modal'))
    showToast('已将「紫云寺家的孩子们」加入想看')
  })

  $$('[data-add-demo]').forEach((button) => {
    button.addEventListener('click', () => {
      const title = $('strong', button.closest('article')).textContent
      button.textContent = '✓ 已加入'
      button.classList.add('is-added')
      button.disabled = true
      closeModal($('#add-modal'))
      showToast(`已将「${title}」加入想看`)
    })
  })

  function resetAuthModal() {
    $('#auth-step-email').hidden = false
    $('#auth-step-code').hidden = true
    $('#auth-status').innerHTML = '&nbsp;'
    $('#code-input').value = ''
  }

  $$('[data-auth-open]').forEach((button) => {
    button.addEventListener('click', () => {
      resetAuthModal()
      openModal($('#auth-modal'), $('#email-input'))
    })
  })

  $('#email-form').addEventListener('submit', (event) => {
    event.preventDefault()
    const emailInput = $('#email-input')
    if (!emailInput.checkValidity()) {
      $('#auth-status').textContent = '请输入有效的邮箱地址。'
      emailInput.focus()
      return
    }
    $('#sent-email').textContent = emailInput.value.trim()
    $('#auth-step-email').hidden = true
    $('#auth-step-code').hidden = false
    $('#auth-status').innerHTML = '&nbsp;'
    $('#code-input').focus()
  })

  $('#auth-back').addEventListener('click', () => {
    $('#auth-step-code').hidden = true
    $('#auth-step-email').hidden = false
    $('#auth-status').innerHTML = '&nbsp;'
    $('#email-input').focus()
  })

  $('#code-input').addEventListener('input', (event) => {
    event.target.value = event.target.value.replace(/\D/g, '').slice(0, 6)
  })

  $('#code-form').addEventListener('submit', (event) => {
    event.preventDefault()
    const code = $('#code-input').value
    if (code !== '062626') {
      $('#auth-status').textContent = '验证码不正确，请输入交互稿验证码。'
      $('#code-input').focus()
      return
    }
    const email = $('#sent-email').textContent
    $$('[data-account-label]').forEach((label) => { label.textContent = '雾中编辑' })
    $('[data-settings-account]').textContent = email
    closeModal($('#auth-modal'))
    showToast('登录成功，欢迎回到编辑部！')
  })

  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k') {
      event.preventDefault()
      switchView('tracks')
      $('#track-search').focus()
      return
    }

    if (event.key === 'Escape') {
      const openModalElement = $$('[data-modal]').find((modal) => !modal.hidden)
      if (openModalElement) {
        closeModal(openModalElement)
        return
      }
      closeAllSelects()
      return
    }

    if (event.key === 'Tab') {
      const modal = $$('[data-modal]').find((item) => !item.hidden)
      if (!modal) return
      const focusable = $$('button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])', modal)
        .filter((item) => !item.hidden && item.offsetParent !== null)
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
  })

  tracks.forEach(updateTrackCard)
  updateCounts()
  updateTrackVisibility()
  renderEpisodeGrid()
  updatePlayerState()
})()
