/** @jsx jsx */
import { React, AllWidgetProps, jsx, css, type SerializedStyles } from 'jimu-core'
import { Loading } from 'jimu-ui'
import ReactDOM from 'react-dom'
import { type IMConfig } from './config'
import { DEFAULT_METEOGRAM_SVG } from './defaultSvg'

const DEFAULT_USER_AGENT = 'YrWeatherExperienceWidget/1.0 (https://your-domain.example contact@example.com)'

interface State {
  svgHtml: string
  isLoading: boolean
  error: string | null
  rawSvg: string | null
  expanded: boolean
}

export default class Widget extends React.PureComponent<AllWidgetProps<IMConfig>, State> {
  private refreshIntervalId: NodeJS.Timer = null
  private lastModifiedHeader: string | null = null
  private lastEtagHeader: string | null = null
  private lastRequestUrl: string | null = null
  private userAgentHeaderWarningLogged = false
  private fallbackUserAgent: string | null = null

  private applyConfigUpdate = (updater: (config: IMConfig) => IMConfig, context: string): boolean => {
    const { onSettingChange, id, config } = this.props
    if (typeof onSettingChange === 'function') {
      const nextConfig = updater(config)
      if (nextConfig !== config) {
        onSettingChange({
          id,
          config: nextConfig
        })
      }
      return true
    }

    console.warn(`onSettingChange is not available (${context}), skipping config update.`)
    return false
  }

  private normalizeUrl = (url?: string | null): string | null => {
    if (!url) return null
    const trimmed = url.trim()
    if (!trimmed) return null

    const tryBuild = (candidate: string): string | null => {
      try {
        return new URL(candidate).toString()
      } catch (err) {
        return null
      }
    }

    return (
      tryBuild(trimmed) ||
      tryBuild(`https://${trimmed}`) ||
      tryBuild(`http://${trimmed}`) ||
      trimmed
    )
  }

  private getEffectiveSourceUrl = (): string | null => {
    const normalized = this.normalizeUrl(this.props.config.sourceUrl)
    if (normalized) return normalized
    const raw = this.props.config.sourceUrl
    if (typeof raw === 'string' && raw.trim()) {
      return raw.trim()
    }
    return null
  }

  private getEffectiveUserAgent = (): string | null => {
    const configured = this.props.config.userAgent
    if (typeof configured === 'string') {
      const trimmed = configured.trim()
      if (trimmed) {
        return trimmed
      }
      if (configured.length > 0) {
        return null
      }
    }
    if (this.fallbackUserAgent) {
      return this.fallbackUserAgent
    }
    return DEFAULT_USER_AGENT
  }
  constructor (props) {
    super(props)
    this.state = {
      svgHtml: null,
      isLoading: false,
      error: null,
      rawSvg: null,
      expanded: false
    }
  }

  componentDidMount(): void {
    this.handleDataSourceChange()
    this.setupAutoRefresh()
  }

  componentDidUpdate(prevProps: AllWidgetProps<IMConfig>): void {
    const cfg = this.props.config
    const prev = prevProps.config
    const fetchRelevantChanged =
      cfg.sourceUrl !== prev.sourceUrl ||
      cfg.autoRefreshEnabled !== prev.autoRefreshEnabled ||
      cfg.refreshInterval !== prev.refreshInterval ||
      cfg.userAgent !== prev.userAgent

    if (fetchRelevantChanged) {
      if (cfg.userAgent !== prev.userAgent) {
        this.userAgentHeaderWarningLogged = false
      }
      this.handleDataSourceChange()
      this.setupAutoRefresh()
    } else if (cfg !== prev) {
      if (this.state.rawSvg) this.processSvg(this.state.rawSvg)
    }

  }

  componentWillUnmount(): void {
    if (this.refreshIntervalId) clearInterval(this.refreshIntervalId)
  }

  handleDataSourceChange = () => {
    const { config } = this.props
    const hasUserAgentConfigured = typeof config.userAgent === 'string'

    if (!hasUserAgentConfigured) {
      const applied = this.applyConfigUpdate(cfg => cfg.set('userAgent', DEFAULT_USER_AGENT), 'apply default user agent')
      if (applied) {
        return
      }
      this.fallbackUserAgent = DEFAULT_USER_AGENT
    } else {
      this.fallbackUserAgent = null
    }

    const normalizedUrl = this.normalizeUrl(config.sourceUrl)
    if (normalizedUrl && normalizedUrl !== config.sourceUrl) {
      const applied = this.applyConfigUpdate(cfg => cfg.set('sourceUrl', normalizedUrl), 'normalize source URL')
      if (applied) {
        return
      }
    }

    const effectiveUrl = normalizedUrl ?? (config.sourceUrl?.trim() ? config.sourceUrl.trim() : null)

    if (effectiveUrl !== this.lastRequestUrl) {
      this.lastModifiedHeader = null
      this.lastEtagHeader = null
      this.lastRequestUrl = effectiveUrl
    }
    const fallbackSvg = this.getFallbackSvg()
    if (effectiveUrl) {
      this.fetchSvgFromUrl(effectiveUrl)
    } else if (fallbackSvg) {
      this.processSvg(fallbackSvg)
    } else {
      this.setState({ svgHtml: null, error: null, isLoading: false, rawSvg: null })
    }
  }

  getFallbackSvg = (): string | null => {
    const svgCode = this.props.config.svgCode
    if (svgCode && svgCode.trim() && !svgCode.trim().startsWith('<!--')) {
      return svgCode
    }
    return DEFAULT_METEOGRAM_SVG
  }

  setupAutoRefresh = (): void => {
    if (this.refreshIntervalId) clearInterval(this.refreshIntervalId)
    const effectiveUrl = this.getEffectiveSourceUrl()
    if (!this.getEffectiveUserAgent()) {
      return
    }
    if (this.props.config.autoRefreshEnabled && this.props.config.refreshInterval > 0 && effectiveUrl) {
      const ms = this.props.config.refreshInterval * 60 * 1000
      this.refreshIntervalId = setInterval(() => this.fetchSvgFromUrl(effectiveUrl), ms)
    }
  }

  toggleExpand = (): void => {
    this.setState((prev) => ({ expanded: !prev.expanded }))
  }

  fetchSvgFromUrl = (url: string, attempt = 1): void => {
    const normalizedUrl = this.normalizeUrl(url)
    if (!normalizedUrl) {
      this.setState({
        isLoading: false,
        error: 'Invalid Source URL provided.'
      })
      return
    }
    const configuredUserAgent = this.getEffectiveUserAgent()
    if (!configuredUserAgent) {
      this.setState({
        isLoading: false,
        error: 'Please configure a valid MET API User Agent before fetching data.'
      })
      return
    }
    if (normalizedUrl !== this.lastRequestUrl) {
      this.lastModifiedHeader = null
      this.lastEtagHeader = null
      this.lastRequestUrl = normalizedUrl
    }
    if (attempt === 1) {
      this.setState({ isLoading: true, error: null })
    }

    this.fetchSvgDirect(normalizedUrl, attempt)
  }

  fetchSvgDirect = (url: string, attempt = 1): void => {
    const hasConditionalHeaders = Boolean(this.lastModifiedHeader || this.lastEtagHeader)
    let requestUrl = url
    if (!hasConditionalHeaders) {
      try {
        const urlObj = new URL(url)
        urlObj.searchParams.set('nocache', Date.now().toString())
        requestUrl = urlObj.toString()
      } catch (err) {
        requestUrl = url + (url.includes('?') ? '&' : '?') + 'nocache=' + Date.now()
      }
    }

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    if (controller) {
      timeoutId = setTimeout(() => controller.abort(), 15000)
    }

    const headers = new Headers({ Accept: 'image/svg+xml,text/html;q=0.9,*/*;q=0.8' })
    const userAgent = this.getEffectiveUserAgent()
    if (userAgent) {
      try {
        headers.set('User-Agent', userAgent)
      } catch (err) {
        if (!this.userAgentHeaderWarningLogged) {
          console.warn('Unable to set User-Agent header for MET request. Ensure widget runs in an environment that allows custom headers.', err)
          this.userAgentHeaderWarningLogged = true
        }
      }
    }
    if (this.lastModifiedHeader) headers.set('If-Modified-Since', this.lastModifiedHeader)
    if (this.lastEtagHeader) headers.set('If-None-Match', this.lastEtagHeader)

    const fetchOptions: RequestInit = {
      cache: hasConditionalHeaders ? 'no-cache' : 'no-store',
      mode: 'cors',
      credentials: 'omit',
      headers
    }
    if (controller) fetchOptions.signal = controller.signal

    fetch(requestUrl, fetchOptions)
      .then(r => {
        if (timeoutId) {
          clearTimeout(timeoutId)
          timeoutId = null
        }
        if (r.status === 304) {
          this.setState({ isLoading: false, error: null })
          return null
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const lastModified = r.headers.get('last-modified')
        const etag = r.headers.get('etag')
        if (lastModified) this.lastModifiedHeader = lastModified
        if (etag) this.lastEtagHeader = etag
        return r.text()
      })
      .then(text => {
        if (!text) {
          return
        }
        const t = text.trim()
        let svgString: string

        if (t.startsWith('<svg') || t.startsWith('<?xml')) {
          svgString = t
        } else {
          const doc = new DOMParser().parseFromString(t, 'text/html')
          const svgEl = doc.querySelector('svg')
          if (!svgEl) throw new Error('No SVG element found in fetched content.')
          svgString = svgEl.outerHTML
        }

        this.processSvg(svgString)

        if (svgString.startsWith('<svg')) {
          this.applyConfigUpdate(cfg => cfg.set('svgCode', svgString), 'store fetched SVG')
        }
      })
      .catch(err => {
        if (controller) controller.abort()
        if (timeoutId) {
          clearTimeout(timeoutId)
          timeoutId = null
        }
        if ((err as any)?.name === 'AbortError') {
          return
        }
        if (attempt < 5) {
          setTimeout(() => this.fetchSvgDirect(url, attempt + 1), 1000 * attempt)
          return
        }
        console.error('Failed to fetch SVG:', err)

        const fallback = this.state.rawSvg || this.getFallbackSvg()
        if (fallback && fallback.trim().startsWith('<svg')) {
          this.processSvg(fallback)
          return
        }

        this.setState({
          isLoading: false,
          error: 'Unable to load meteogram from source.'
        })
      })
      .finally(() => {
        if (timeoutId) clearTimeout(timeoutId)
      })
  }

  processSvg = (svgCode: string): void => {
    const doc = new DOMParser().parseFromString(svgCode, 'image/svg+xml')
    const svg = doc.querySelector('svg')
    if (!svg) {
      this.setState({ error: 'Invalid SVG content', isLoading: false })
      return
    }

    if (!svg.hasAttribute('viewBox')) {
      const rawWidth = svg.getAttribute('width')?.replace('px', '')
      const rawHeight = svg.getAttribute('height')?.replace('px', '')
      if (rawWidth && rawHeight && !Number.isNaN(Number(rawWidth)) && !Number.isNaN(Number(rawHeight))) {
        svg.setAttribute('viewBox', `0 0 ${rawWidth} ${rawHeight}`)
      }
    }

    svg.removeAttribute('width')
    svg.removeAttribute('height')
    if (!svg.getAttribute('preserveAspectRatio')) {
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
    }

    svg.querySelectorAll('style').forEach(el => el.remove())
    svg.querySelectorAll('filter').forEach(el => el.remove())
    svg.querySelectorAll('[filter]').forEach(el => el.removeAttribute('filter'))

    const isWhite = (value?: string | null) => {
      const v = (value || '').trim().toLowerCase()
      return v === '#fff' || v === '#ffffff' || v === 'white' || v === 'rgb(255,255,255)' || v === 'rgb(255, 255, 255)'
    }

    svg.querySelectorAll('rect').forEach(rect => {
      const fill = rect.getAttribute('fill')
      const style = rect.getAttribute('style') || ''
      const styleHasWhite = /(^|;)\s*fill\s*:\s*(#fff|#ffffff|white|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\))\s*;?/i.test(style)
      if (isWhite(fill) || styleHasWhite) {
        rect.setAttribute('fill', 'none')
        if (styleHasWhite) {
          rect.setAttribute('style', style.replace(/(^|;)\s*fill\s*:\s*[^;]+;?/gi, '$1'))
        }
      }
    })

    const { overallBackground } = this.props.config
    svg.querySelectorAll('foreignObject').forEach(fo => {
      const inner = fo.querySelector<HTMLElement>('*')
      if (inner) {
        const existing = inner.getAttribute('style') || ''
        inner.setAttribute('style', `${existing};background:${overallBackground} !important;`)
      }
    })

    const serializer = new XMLSerializer()
    const serializedSvg = serializer.serializeToString(svg)

    this.setState({
      svgHtml: serializedSvg,
      isLoading: false,
      error: null,
      rawSvg: svgCode
    })
  }

  private renderRefreshIcon = (): React.ReactElement => (
    <span className="icon-wrapper" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="14" height="14" role="img" aria-hidden="true">
        <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          d="M21 12a9 9 0 1 1-3.4-7L21 8m0-4v4h-4" />
      </svg>
    </span>
  )

  private renderContent = (config: IMConfig, expanded: boolean): React.ReactNode => {
    const { isLoading, error, svgHtml } = this.state
    const effectiveSourceUrl = this.getEffectiveSourceUrl()

    const popupBorderRadius = Number.isFinite(config.popupBorderRadius) ? config.popupBorderRadius : 0

    const svgContainerStyle: React.CSSProperties = {
      width: '100%',
      height: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      overflow: expanded ? 'visible' : 'hidden',
      borderRadius: 'inherit',
      flex: '1 1 auto',
      minHeight: 0
    }

    const wrappedContent = (node: React.ReactNode) => expanded
      ? (
        <div
          style={{
            width: '100%',
            height: '100%',
            boxSizing: 'border-box',
            borderRadius: 'inherit',
            display: 'flex',
            alignItems: 'stretch',
            justifyContent: 'center',
            overflow: 'visible',
            flex: '1 1 auto',
            minHeight: 0
          }}
        >
          {node}
        </div>
        )
      : node

    if (isLoading) return wrappedContent(<Loading />)

    if (error) {
      return wrappedContent(
        <div style={{ padding: '10px', textAlign: 'center', color: 'red' }}>
          {error}
          {effectiveSourceUrl && (
            <div style={{ marginTop: 10, display: 'flex', justifyContent: 'center' }}>
              <button
                className="action-button refresh-button large"
                onClick={() => this.fetchSvgFromUrl(effectiveSourceUrl)}
                title="Refresh graph"
                aria-label="Refresh graph"
              >
                {this.renderRefreshIcon()}
              </button>
            </div>
          )}
        </div>
      )
    }

    if (svgHtml) {
      return wrappedContent(
        <div
          className="svg-image-container"
          style={svgContainerStyle}
          dangerouslySetInnerHTML={{ __html: svgHtml }}
        />
      )
    }

    return wrappedContent(
      <div style={{ padding: 10, textAlign: 'center' }}>
        Please configure a Source URL or provide Fallback SVG Code.
      </div>
    )
  }

  buildScopedCss = (config: IMConfig, scope: string) => {
    const gridLineWidth = typeof config.gridLineWidth === 'number' ? config.gridLineWidth : 1
    const rawGridOpacity = typeof config.gridLineOpacity === 'number' ? config.gridLineOpacity : 1
    const gridLineOpacity = Number.isFinite(rawGridOpacity) ? Math.min(1, Math.max(0, rawGridOpacity)) : 1

    return `
    .${scope} {
      background-color: ${config.overallBackground};
      position: relative;
    }

    .${scope} .button-container {
      position: absolute;
      top: clamp(24px, 3vw, 32px);
      left: 50%;
      transform: translate(-50%, -50%);
      display: flex;
      gap: clamp(6px, 1vw, 12px);
      z-index: 10;
    }

    .${scope} .action-button {
      cursor: pointer;
      border: none;
      line-height: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      height: clamp(24px, 3vw, 28px);
      width: clamp(24px, 3vw, 28px);
      border-radius: ${config.expandButtonBorderRadius}px;
    }

    .${scope} .action-button .icon-wrapper {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
    }

    .${scope} .refresh-button {
      background: ${config.refreshButtonBackgroundColor};
      color: ${config.refreshButtonIconColor};
    }

    .${scope} .refresh-button svg path {
      stroke: currentColor !important;
      fill: none !important;
    }

    .${scope} .refresh-button.large {
      width: clamp(36px, 4vw, 44px);
      height: clamp(36px, 4vw, 44px);
    }

    .${scope} .expand-button {
      background: ${config.expandButtonBackgroundColor};
      color: ${config.expandButtonIconColor};
    }

    .${scope} .expand-button .icon-wrapper,
    .${scope} .close-button .icon-wrapper {
      font-size: 14px;
      line-height: 1;
    }

    .${scope} .svg-image-container {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      border-radius: inherit;
      flex: 1 1 auto;
      min-height: 0;
    }

    .${scope} .svg-image-container svg {
      width: 100%;
      height: 100%;
      max-height: 100%;
      display: block;
      background-color: ${config.overallBackground} !important;
    }

    .${scope} .svg-image-container svg > rect:first-of-type {
      fill: ${config.overallBackground} !important;
    }

    .${scope} .svg-image-container svg foreignObject > * {
      background: ${config.overallBackground} !important;
      color: ${config.mainTextColor} !important;
    }

    .${scope} .svg-image-container svg .location-header,
    .${scope} .svg-image-container svg .day-label,
    .${scope} .svg-image-container svg .served-by-header,
    .${scope} .svg-image-container svg .legend-label,
    .${scope} .svg-image-container svg text {
      fill: ${config.mainTextColor} !important;
    }

    .${scope} .svg-image-container svg .hour-label,
    .${scope} .svg-image-container svg .y-axis-label {
      fill: ${config.secondaryTextColor} !important;
    }

    .${scope} .svg-image-container svg g[filter*="invert"] {
      filter: none !important;
    }

    .${scope} .svg-image-container svg [fill="#56616c"],
    .${scope} .svg-image-container svg [stroke="#56616c"],
    .${scope} .svg-image-container svg [style*="fill:#56616c"],
    .${scope} .svg-image-container svg [style*="stroke:#56616c"],
    .${scope} .svg-image-container svg [style*="rgb(86,97,108)"] {
      fill: ${config.yAxisIconColor} !important;
      stroke: ${config.yAxisIconColor} !important;
    }

    .${scope} .svg-image-container svg [stroke="currentColor"] {
      stroke: ${config.yAxisIconColor} !important;
    }

    .${scope} .svg-image-container svg [fill="currentColor"] {
      fill: ${config.yAxisIconColor} !important;
    }

    .${scope} .svg-image-container svg line[stroke="#c3d0d8"],
    .${scope} .svg-image-container svg path[stroke="#c3d0d8"],
    .${scope} .svg-image-container svg polyline[stroke="#c3d0d8"],
    .${scope} .svg-image-container svg line[stroke="#56616c"],
    .${scope} .svg-image-container svg path[stroke="#56616c"],
    .${scope} .svg-image-container svg polyline[stroke="#56616c"] {
      stroke: ${config.gridLineColor} !important;
      stroke-width: ${gridLineWidth}px !important;
      stroke-opacity: ${gridLineOpacity} !important;
    }

    .${scope} .svg-image-container svg path[stroke="url(#temperature-curve-gradient)"],
    .${scope} .svg-image-container svg path[stroke="#c60000"] {
      stroke: ${config.temperatureLineColor} !important;
    }

    .${scope} .svg-image-container svg path[stroke="#aa00f2"]:not([stroke-dasharray]) {
      stroke: ${config.windLineColor} !important;
    }

    .${scope} .svg-image-container svg path[stroke="#aa00f2"][stroke-dasharray] {
      stroke: ${config.windGustLineColor} !important;
    }

    .${scope} .svg-image-container svg svg rect[fill="#c60000"] {
      fill: ${config.temperatureLineColor} !important;
    }

    .${scope} .svg-image-container svg svg rect[fill="#aa00f2"]:not([rx]) {
      fill: ${config.windLineColor} !important;
    }

    .${scope} .svg-image-container svg svg rect[fill="#aa00f2"][rx] {
      fill: ${config.windGustLineColor} !important;
    }

    .${scope} .svg-image-container svg rect[fill="#006edb"],
    .${scope} .svg-image-container svg path[stroke="#006edb"],
    .${scope} .svg-image-container svg line[stroke="#006edb"] {
      fill: ${config.precipitationBarColor} !important;
      stroke: ${config.precipitationBarColor} !important;
    }

    .${scope} .svg-image-container svg #max-precipitation-pattern rect {
      fill: ${config.maxPrecipitationColor} !important;
      opacity: 0.3 !important;
    }

    .${scope} .svg-image-container svg #max-precipitation-pattern line {
      stroke: ${config.maxPrecipitationColor} !important;
      opacity: 1 !important;
    }

    .${scope} .svg-image-container svg svg[x="16"] circle {
      fill: ${config.yrLogoBackgroundColor} !important;
    }

    .${scope} .svg-image-container svg svg[x="16"] path {
      fill: ${config.yrLogoTextColor} !important;
    }

    .${scope} .svg-image-container svg svg[x="624"] path,
    .${scope} .svg-image-container svg svg[x="675.5"] path,
    .${scope} .svg-image-container svg svg[viewBox="0 0 68 24"] path,
    .${scope} .svg-image-container svg svg[viewBox="0 0 89 24"] path {
      fill: ${config.logoColor} !important;
    }
  `
  }
  getStyle = (config: IMConfig): SerializedStyles => css`
    & {
      box-sizing: border-box;
      width: 100%;
      height: 100%;
      padding: ${config.padding ?? 0}px;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }
    .svg-image-container {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      border-radius: inherit;
    }
  `

  render(): React.ReactElement { 
    const { config, id } = this.props
    const { expanded } = this.state
    const scopeClass = `yrw-${id}`

    const effectiveSourceUrl = this.getEffectiveSourceUrl()
    const content = this.renderContent(config, false)

    const popupContent = this.renderContent(config, true)

    const showControls = effectiveSourceUrl && !expanded && !this.state.error

    return (
      <div className={scopeClass} css={this.getStyle(config)}>
        <style dangerouslySetInnerHTML={{ __html: this.buildScopedCss(config, scopeClass) }} />

        {showControls && (
          <div className="button-container">
            <button
              className="action-button refresh-button"
              onClick={() => effectiveSourceUrl && this.fetchSvgFromUrl(effectiveSourceUrl)}
              title="Refresh graph"
              aria-label="Refresh graph"
            >{this.renderRefreshIcon()}</button>
            <button
              className="action-button expand-button"
              onClick={this.toggleExpand}
              title="Expand graph"
              aria-label="Expand graph"
            >
              <span className="icon-wrapper" aria-hidden="true">⛶</span>
            </button>
          </div>
        )}

        {!expanded && content}

        {expanded && ReactDOM.createPortal(
          <div className={`${scopeClass} popup`}>
            {config.blockPage && (
              <div
                onClick={this.toggleExpand}
                style={{
                  position: 'fixed',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  background: config.maskColor,
                  zIndex: 2147483646
                }}
              />
            )}
            <div
              style={{
                position: 'fixed',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                width: '70vw',
                height: '70vh',
                background: config.popupBackgroundColor,
                zIndex: 2147483647,
                padding: `${config.popupPadding}px`,
                borderRadius: `${config.popupBorderRadius}px`,
                boxShadow: `${config.popupBoxShadowOffsetX}px ${config.popupBoxShadowOffsetY}px ${config.popupBoxShadowBlur}px ${config.popupBoxShadowSpread}px ${config.popupBoxShadowColor}`,
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'stretch',
                justifyContent: 'flex-start',
                gap: '16px'
              }}
            >
              <div className="button-container">
                <button
                  className="action-button refresh-button"
                  onClick={() => effectiveSourceUrl && this.fetchSvgFromUrl(effectiveSourceUrl)}
                  title="Refresh graph"
                  aria-label="Refresh graph"
                >
                  {this.renderRefreshIcon()}
                </button>
                <button
                  className="action-button expand-button close-button"
                  onClick={this.toggleExpand}
                  title="Close graph"
                  aria-label="Close graph"
                >
                  <span className="icon-wrapper" aria-hidden="true">×</span>
                </button>
              </div>
              {popupContent}
            </div>
          </div>,
          document.body
        )}
      </div>
    )
  }
}
