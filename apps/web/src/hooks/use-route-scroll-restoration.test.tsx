import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { useRouteScrollRestoration } from '@/hooks/use-route-scroll-restoration'

function Harness() {
  useRouteScrollRestoration()
  const navigate = useNavigate()
  const location = useLocation()
  return (
    <>
      <nav>
        <button type="button" onClick={() => void navigate('/app/library')}>
          Push
        </button>
        <button
          type="button"
          onClick={() => void navigate('/app/stats', { replace: true })}
        >
          Replace
        </button>
        <button type="button" onClick={() => void navigate('/app/mix?step=2')}>
          Same page
        </button>
        <button type="button" onClick={() => void navigate(-1)}>
          Back
        </button>
      </nav>
      <main tabIndex={-1}>
        <p>{location.pathname}</p>
        <button type="button">Inside</button>
      </main>
    </>
  )
}

let scrollY = 0
const scrollTo = vi.fn((_x: number, y: number) => {
  scrollY = y
})

function scrollWindowTo(top: number) {
  scrollY = top
  act(() => {
    window.dispatchEvent(new Event('scroll'))
  })
}

async function nextFrame() {
  await act(
    () => new Promise((resolve) => window.requestAnimationFrame(resolve)),
  )
}

function renderHarness(route = '/app/mix') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Harness />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  scrollY = 0
  scrollTo.mockClear()
  Object.defineProperty(window, 'scrollY', {
    configurable: true,
    get: () => scrollY,
  })
  vi.spyOn(window, 'scrollTo').mockImplementation(
    scrollTo as unknown as typeof window.scrollTo,
  )
  sessionStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useRouteScrollRestoration', () => {
  it('starts a pushed page at the top with focus on the main content', async () => {
    const user = userEvent.setup()
    renderHarness()
    scrollWindowTo(900)
    await nextFrame()

    await user.click(screen.getByRole('button', { name: 'Push' }))

    expect(screen.getByText('/app/library')).toBeInTheDocument()
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0)
    expect(screen.getByRole('main')).toHaveFocus()
  })

  it('treats a replace to another page like a push', async () => {
    const user = userEvent.setup()
    renderHarness()
    scrollWindowTo(400)

    await user.click(screen.getByRole('button', { name: 'Replace' }))

    expect(scrollTo).toHaveBeenLastCalledWith(0, 0)
    expect(screen.getByRole('main')).toHaveFocus()
  })

  it('restores the previous position on back without moving focus', async () => {
    const user = userEvent.setup()
    renderHarness()
    scrollWindowTo(900)
    await nextFrame()
    await user.click(screen.getByRole('button', { name: 'Push' }))
    scrollWindowTo(200)
    await nextFrame()

    const back = screen.getByRole('button', { name: 'Back' })
    await user.click(back)

    expect(screen.getByText('/app/mix')).toBeInTheDocument()
    expect(scrollTo).toHaveBeenLastCalledWith(0, 900)
    expect(back).toHaveFocus()
  })

  it('leaves scroll and focus alone when only the search changes', async () => {
    const user = userEvent.setup()
    renderHarness()
    scrollWindowTo(600)

    const samePage = screen.getByRole('button', { name: 'Same page' })
    await user.click(samePage)

    expect(scrollTo).not.toHaveBeenCalled()
    expect(samePage).toHaveFocus()
  })

  it('keeps focus that the new page already placed inside the main content', async () => {
    renderHarness()
    screen.getByRole('button', { name: 'Inside' }).focus()

    await act(async () => {
      screen.getByRole('button', { name: 'Push' }).click()
    })

    expect(screen.getByText('/app/library')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Inside' })).toHaveFocus()
  })

  it('saves positions for the session when the page is hidden', async () => {
    renderHarness()
    scrollWindowTo(320)
    await nextFrame()

    window.dispatchEvent(new Event('pagehide'))

    expect(
      JSON.parse(sessionStorage.getItem('blendify.scrollPositions') ?? '[]'),
    ).toEqual([['default', 320]])
  })

  it('restores the position saved before a reload', () => {
    sessionStorage.setItem(
      'blendify.scrollPositions',
      JSON.stringify([['default', 750]]),
    )

    renderHarness()

    expect(scrollTo).toHaveBeenLastCalledWith(0, 750)
  })
})
