import { useCallback, useEffect, useRef, useState } from 'react'

type BrowserDisplayMediaOptions = DisplayMediaStreamOptions & {
  preferCurrentTab?: boolean
  selfBrowserSurface?: 'include' | 'exclude'
  surfaceSwitching?: 'include' | 'exclude'
  systemAudio?: 'include' | 'exclude'
}

const VIDEO_CLEAN_CLASS = 'demo-video-clean'

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function getFileStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

async function requestDisplayStream() {
  const preferredOptions: BrowserDisplayMediaOptions = {
    video: { displaySurface: 'browser' },
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
    surfaceSwitching: 'include',
    systemAudio: 'exclude',
  }

  try {
    return await navigator.mediaDevices.getDisplayMedia(preferredOptions)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotAllowedError') throw error
    return navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
  }
}

export function DemoRecorder() {
  const [isRecording, setIsRecording] = useState(false)
  const [message, setMessage] = useState('Готово к записи видео')
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const videoChunksRef = useRef<BlobPart[]>([])
  const streamRef = useRef<MediaStream | null>(null)

  const stopVideoRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop()
      return
    }

    streamRef.current?.getTracks().forEach((track) => track.stop())
    document.documentElement.classList.remove(VIDEO_CLEAN_CLASS)
    setIsRecording(false)
  }, [])

  const startVideoRecording = useCallback(async () => {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setMessage('Видео-запись не поддерживается в этом браузере.')
      return
    }

    try {
      const stream = await requestDisplayStream()
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' })
      videoChunksRef.current = []
      streamRef.current = stream
      mediaRecorderRef.current = recorder

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) videoChunksRef.current.push(event.data)
      }
      recorder.onstop = () => {
        const blob = new Blob(videoChunksRef.current, { type: 'video/webm' })
        if (blob.size > 0) downloadBlob(blob, `demo-video-${getFileStamp()}.webm`)
        stream.getTracks().forEach((track) => track.stop())
        document.documentElement.classList.remove(VIDEO_CLEAN_CLASS)
        streamRef.current = null
        mediaRecorderRef.current = null
        setIsRecording(false)
        setMessage(blob.size > 0 ? 'Видео-демо сохранено.' : 'Видео-запись остановлена без данных.')
      }

      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (recorder.state !== 'inactive') recorder.stop()
      })

      document.documentElement.classList.add(VIDEO_CLEAN_CLASS)
      recorder.start()
      setIsRecording(true)
      setMessage('Идёт видео-запись экрана. Нажмите Esc или Stop sharing для остановки.')
    } catch {
      document.documentElement.classList.remove(VIDEO_CLEAN_CLASS)
      setMessage('Не удалось начать видео-запись: доступ к экрану не выдан.')
    }
  }, [])

  useEffect(() => {
    if (!isRecording) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') stopVideoRecording()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isRecording, stopVideoRecording])

  useEffect(() => {
    return () => document.documentElement.classList.remove(VIDEO_CLEAN_CLASS)
  }, [])

  return (
    <div className={`demo-recorder${isRecording ? ' recording' : ''}`} aria-label="Запись видео демо">
      <span className="demo-recorder-status">{isRecording ? 'Видео запись' : 'Демо'}</span>
      <div className="demo-recorder-actions">
        {isRecording ? (
          <button type="button" className="demo-recorder-btn stop" onClick={stopVideoRecording}>
            Стоп видео
          </button>
        ) : (
          <button type="button" className="demo-recorder-btn" onClick={startVideoRecording}>
            Видео
          </button>
        )}
      </div>
      <span className="demo-recorder-hint">{message}</span>
    </div>
  )
}
