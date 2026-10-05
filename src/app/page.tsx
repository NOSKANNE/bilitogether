'use client'

import { useEffect, useState } from 'react'
import { HomeView } from '@/components/home-view'
import { RoomView } from '@/components/room-view'

function useHashRoute(): string {
  const [hash, setHash] = useState('')
  useEffect(() => {
    const update = () => setHash(window.location.hash)
    update()
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])
  return hash
}

export default function Page() {
  const hash = useHashRoute()
  const roomMatch = hash.match(/^#\/room\/([A-Za-z0-9]{4,12})/)

  if (roomMatch) {
    return <RoomView code={roomMatch[1].toUpperCase()} />
  }
  return <HomeView />
}
