import { describe, it, expect, vi } from 'vitest'
import { parseMarkers } from '../src/core/markers.js'

describe('parseMarkers', () => {
  it('extracts a file marker with caption and strips it from the text', () => {
    const result = parseMarkers('Here you go: [[file:/tmp/report.pdf|monthly report]] done')
    expect(result.attachments).toEqual([{ filePath: '/tmp/report.pdf', caption: 'monthly report' }])
    expect(result.text).toBe('Here you go:  done')
    expect(result.text).not.toContain('[[file:')
  })

  it('extracts a file marker without a caption', () => {
    const result = parseMarkers('[[file:/tmp/a.png]]')
    expect(result.attachments).toEqual([{ filePath: '/tmp/a.png' }])
  })

  it('parses inline keyboards with rows and buttons', () => {
    const result = parseMarkers('Pick: [[keyboard:Yes=yes,No=no|Maybe=maybe]]')
    expect(result.keyboard).toEqual([
      [
        { text: 'Yes', callbackData: 'yes' },
        { text: 'No', callbackData: 'no' }
      ],
      [{ text: 'Maybe', callbackData: 'maybe' }]
    ])
  })

  it('defaults callback data to the label when no "=" is present', () => {
    const result = parseMarkers('[[keyboard:Confirm]]')
    expect(result.keyboard).toEqual([[{ text: 'Confirm', callbackData: 'Confirm' }]])
  })

  it('truncates callback data to 64 bytes', () => {
    const long = 'x'.repeat(100)
    const result = parseMarkers(`[[keyboard:Go=${long}]]`)
    expect(result.keyboard![0]![0]!.callbackData).toHaveLength(64)
  })

  it('extracts memory markers', () => {
    const result = parseMarkers('[[memory:user_pref|likes terse replies]]')
    expect(result.memories).toEqual([{ key: 'user_pref', value: 'likes terse replies' }])
  })

  it('handles multiple markers of each type and trims the result', () => {
    const result = parseMarkers(
      '  Text [[file:/a.txt]] more [[memory:k1|v1]] [[memory:k2|v2]] [[keyboard:A=a]]  '
    )
    expect(result.attachments).toHaveLength(1)
    expect(result.memories).toEqual([
      { key: 'k1', value: 'v1' },
      { key: 'k2', value: 'v2' }
    ])
    expect(result.keyboard).toBeDefined()
    expect(result.text).toBe('Text  more')
  })

  it('omits keyboard when no keyboard marker is present', () => {
    const result = parseMarkers('plain text')
    expect(result.keyboard).toBeUndefined()
  })

  it('blocks attachments rejected by allowAttachment and reports them', () => {
    const onBlocked = vi.fn()
    const result = parseMarkers('[[file:/etc/passwd]] [[file:/work/ok.txt]]', {
      allowAttachment: (p) => p.startsWith('/work/'),
      onAttachmentBlocked: onBlocked
    })
    expect(result.attachments).toEqual([{ filePath: '/work/ok.txt' }])
    expect(onBlocked).toHaveBeenCalledWith('/etc/passwd')
  })
})
