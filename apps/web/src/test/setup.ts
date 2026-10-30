import '@testing-library/jest-dom/vitest'
import { usePlaylistRunStore } from '@/stores/playlist-run-store'

HTMLDialogElement.prototype.showModal ??= function showModal(
  this: HTMLDialogElement,
) {
  this.setAttribute('open', '')
}

HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
  if (!this.hasAttribute('open')) {
    return
  }
  this.removeAttribute('open')
  this.dispatchEvent(new Event('close'))
}

window.scrollTo = () => {}

afterEach(() => {
  usePlaylistRunStore.getState().discard()
  sessionStorage.clear()
})
