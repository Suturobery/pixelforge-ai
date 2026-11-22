# One-off: upgrade parseCommand/applyCommand in agent-panel.tsx (exact-text edits).
p = 'src/components/pixelforge/agent-panel.tsx'
s = open(p, encoding='utf-8').read()

old1 = r"""    if (/\badd\b.*\bframe\b/.test(t)) return { tool: 'add_frame', args: num ? { copyContent: true } : {} }"""
new1 = r"""    const frameCount = num ? Math.min(8, Math.max(1, parseInt(num, 10))) : 1
    const wantsCopies = /\b(cop\w*|duplicate\w*|clone\w*)\b/.test(t)
    const wantsEmpty = /\b(empty|blank)\b/.test(t)
    if (/\badd\b.*\bframes?\b/.test(t)) {
      if (frameCount === 1) return { tool: 'add_frame', args: wantsCopies ? { copyContent: true } : {} }
      // N frames: one undoable BATCH (all-or-nothing) — but empty vs copies
      // must be explicit when N > 1 (silently guessing destroys work intent)
      if (!wantsCopies && !wantsEmpty) {
        return { clarify: 'Add ' + frameCount + ' frames - empty or copies of the current frame?' }
      }
      const steps = []
      for (let i = 0; i < frameCount; i++) {
        steps.push(wantsCopies ? { tool: 'add_frame', args: { copyContent: true } } : { tool: 'add_frame', args: {} })
      }
      return { tool: 'batch', args: { steps } }
    }"""
assert old1 in s, 'parseCommand add-frame not found'
s = s.replace(old1, new1, 1)

old2 = r"""  const applyCommand = () => {
    const mapped = parseCommand(nlText)
    if (!mapped) {
      toast({
        title: 'No matching command',
        description: 'Try: flip h · flip v · rotate ccw · shift left · add frame · add layer · merge · opacity 50 · undo · redo',
        variant: 'destructive',
      })
      return
    }
    const tool = MCP_TOOLS.find((x) => x.name === mapped.tool)
    if (!tool) return
    setToolName(tool.name)
    const merged = { ...structuredClone(tool.example), ...mapped.args }
    for (const [k, v] of Object.entries(merged)) {
      if (typeof v === 'string' && /^<.*>$/.test(v.trim())) delete merged[k]
    }
    setArgsText(JSON.stringify(merged, null, 2))
    setResult(null)
    setShowManual(true)
    toast({ title: \, description: 'Review the args, then press Run.' })
  }"""
new2 = """  const applyCommand = () => {
    const mapped = parseCommand(nlText)
    if (!mapped) {
      // explain what the panel understood and what it supports — NOTHING runs
      // or edits until the user corrects the command
      const verbs = ['flip', 'rotate', 'shift', 'move', 'undo', 'redo', 'add', 'duplicate', 'delete', 'merge', 'opacity', 'create'].filter((v) =>
        new RegExp('\\\\b' + v, 'i').test(nlText),
      )
      const understood =
        verbs.length > 0
          ? 'I recognized ' + verbs.map((v) => '"' + v + '"').join(', ') + " but couldn't map them to a supported edit."
          : 'No supported edit found in that command.'
      toast({
        title: understood,
        description:
          'Supported: flip h/v · rotate cw/ccw · shift left/right/up/down · add N empty frames · add N copies · duplicate frame · add layer · merge · opacity N · new project · undo · redo',
        variant: 'destructive',
      })
      setInterpreted(null)
      setClarify(null)
      return
    }
    if ('clarify' in mapped) {
      const msg = (mapped as { clarify: string }).clarify
      const n = parseInt(nlText.match(/\\b(\\d+)\\b/)?.[1] ?? '4', 10) || 4
      setClarify({
        plain: msg,
        options: [
          {
            label: 'Add ' + n + ' empty frames',
            tool: 'batch',
            args: { steps: Array.from({ length: n }, () => ({ tool: 'add_frame', args: {} })) },
          },
          {
            label: 'Add ' + n + ' copies of the current frame',
            tool: 'batch',
            args: { steps: Array.from({ length: n }, () => ({ tool: 'add_frame', args: { copyContent: true } })) },
          },
        ],
      })
      setInterpreted(null)
      return
    }
    const mappedTool = mapped as { tool: string; args: Record<string, unknown> }
    const tool = MCP_TOOLS.find((x) => x.name === mappedTool.tool)
    if (!tool) return
    const merged = { ...structuredClone(tool.example), ...mappedTool.args }
    for (const [k, v] of Object.entries(merged)) {
      if (typeof v === 'string' && /^<.*>$/.test(v.trim())) delete merged[k]
    }
    setToolName(tool.name)
    setArgsText(JSON.stringify(merged, null, 2))
    setResult(null)
    setClarify(null)
    setShowManual(true)
    // plain-language interpreted action + target ABOVE the JSON controls
    const st = useEditor.getState()
    const clip = st.project.clips.find((c) => c.id === st.activeClipId) ?? st.project.clips[0]
    const target = clip
      ? 'clip "' + clip.name + '" (' + clip.layers.length + ' layer' + (clip.layers.length === 1 ? '' : 's') + ', ' + clip.frames.length + ' frame' + (clip.frames.length === 1 ? '' : 's') + ')'
      : 'active clip'
    const stepCount = (mappedTool.args as { steps?: unknown[] }).steps?.length
    const plain =
      mappedTool.tool === 'batch'
        ? 'Will: run ' + (stepCount ?? '?') + ' add_frame steps as ONE undoable operation on ' + target + ' - nothing runs until you press Run.'
        : 'Will: ' + tool.description.split('.')[0] + ' on ' + target + ' - nothing runs until you press Run.'
    setInterpreted({ plain, target: mappedTool.tool })
    toast({ title: 'Ready: ' + tool.name, description: 'Review the interpreted action, then press Run.' })
  }"""
assert old2 in s, 'applyCommand not found'
s = s.replace(old2, new2, 1)

open(p, 'w', encoding='utf-8', newline='').write(s)
print('agent-panel parse/apply upgraded')
