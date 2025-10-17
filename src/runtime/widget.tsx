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

type FetchTarget = { requestUrl: string, kind: 'svg' | 'locationforecast' }

type WeatherSymbolCategory = 'clear' | 'partly' | 'cloudy' | 'rain' | 'snow' | 'sleet' | 'fog'

interface ForecastPoint {
  date: Date
  temperature: number | null
  windSpeed: number | null
  windGust: number | null
  precipitation: number
  symbolCode: string | null
}

export default class Widget extends React.PureComponent<AllWidgetProps<IMConfig>, State> {
  private refreshIntervalId: NodeJS.Timer = null
  private lastModifiedHeader: string | null = null
  private lastEtagHeader: string | null = null
  private lastRequestUrl: string | null = null
  private lastSourceInput: string | null = null
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

  private getEffectiveSourceInput = (): string | null => {
    const normalized = this.normalizeUrl(this.props.config.sourceUrl)
    if (normalized) return normalized
    const raw = this.props.config.sourceUrl
    if (typeof raw === 'string' && raw.trim()) {
      return raw.trim()
    }
    return null
  }

  private truncateCoordinate = (value: number): string | null => {
    if (!Number.isFinite(value)) return null
    const truncated = Math.round(Math.abs(value) * 10000) / 10000
    const signed = value < 0 ? -truncated : truncated
    const fixed = signed.toFixed(4)
    return fixed.replace(/\.0+$/, '').replace(/(\.\d*?[1-9])0+$/, '$1')
  }

  private escapeXml = (value: string): string =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')

  private formatCoordinateForLabel = (value?: number | null): string | null => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return null
    }
    return value.toFixed(3)
  }

  private getWeatherSymbolCategory = (symbolCode?: string | null): WeatherSymbolCategory => {
    const normalized = (symbolCode ?? '').toLowerCase()
    if (!normalized) {
      return 'cloudy'
    }

    const trimmed = normalized
      .replace(/_(day|night|polartwilight)$/g, '')
      .replace(/_?thunder(storm)?$/g, '')

    if (/(sleet|rain\s*snow|snow\s*rain)/.test(trimmed)) return 'sleet'
    if (/(snow|hail)/.test(trimmed)) return 'snow'
    if (/rain/.test(trimmed)) return 'rain'
    if (/fog|mist/.test(trimmed)) return 'fog'
    if (/(partly|light)cloud/.test(trimmed) || /fair/.test(trimmed)) return 'partly'
    if (/cloud/.test(trimmed)) return 'cloudy'
    if (/clear|sun/.test(trimmed)) return 'clear'
    return 'partly'
  }

  private buildWeatherIconSvg = (category: WeatherSymbolCategory, size: number): string => {
    const center = size / 2
    const stroke = size * 0.05

    const buildSun = (cx: number, cy: number, radiusScale = 0.36) => {
      const radius = size * radiusScale
      const rayOuter = radius + size * 0.16
      const rays: string[] = []
      for (let i = 0; i < 8; i++) {
        const angle = (Math.PI / 4) * i
        const innerX = cx + Math.cos(angle) * (radius + stroke * 0.6)
        const innerY = cy + Math.sin(angle) * (radius + stroke * 0.6)
        const outerX = cx + Math.cos(angle) * rayOuter
        const outerY = cy + Math.sin(angle) * rayOuter
        rays.push(`<line x1="${innerX.toFixed(2)}" y1="${innerY.toFixed(2)}" x2="${outerX.toFixed(2)}" y2="${outerY.toFixed(2)}" stroke="#f7b733" stroke-width="${(stroke * 0.9).toFixed(2)}" stroke-linecap="round" />`)
      }
      return `
        <g>
          ${rays.join('')}
          <circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${radius.toFixed(2)}" fill="#fcd147" stroke="#f7b733" stroke-width="${stroke.toFixed(2)}" />
        </g>
      `
    }

    const buildCloud = (cx: number, cy: number, scale = 1) => {
      const width = size * 0.72 * scale
      const height = size * 0.38 * scale
      const left = cx - width / 2
      const rectHeight = height * 0.65
      return `
        <g fill="#dfe4ec" stroke="#c1c8d2" stroke-width="${(stroke * scale).toFixed(2)}" stroke-linejoin="round">
          <ellipse cx="${(cx - width * 0.25).toFixed(2)}" cy="${cy.toFixed(2)}" rx="${(width * 0.25).toFixed(2)}" ry="${(height * 0.52).toFixed(2)}" />
          <ellipse cx="${cx.toFixed(2)}" cy="${(cy - height * 0.45).toFixed(2)}" rx="${(width * 0.3).toFixed(2)}" ry="${(height * 0.6).toFixed(2)}" />
          <ellipse cx="${(cx + width * 0.28).toFixed(2)}" cy="${cy.toFixed(2)}" rx="${(width * 0.32).toFixed(2)}" ry="${(height * 0.52).toFixed(2)}" />
          <rect x="${left.toFixed(2)}" y="${(cy - rectHeight / 2).toFixed(2)}" width="${width.toFixed(2)}" height="${rectHeight.toFixed(2)}" rx="${(rectHeight / 2).toFixed(2)}" />
        </g>
      `
    }

    const buildRaindrop = (cx: number, cy: number, scale = 1) => {
      const height = size * 0.28 * scale
      const width = size * 0.16 * scale
      const topY = cy - height / 2
      return `<path d="M${cx.toFixed(2)} ${topY.toFixed(2)} C ${(cx + width / 2).toFixed(2)} ${(cy - height * 0.15).toFixed(2)}, ${(cx + width / 2).toFixed(2)} ${(cy + height * 0.35).toFixed(2)}, ${cx.toFixed(2)} ${(cy + height / 2).toFixed(2)} C ${(cx - width / 2).toFixed(2)} ${(cy + height * 0.35).toFixed(2)}, ${(cx - width / 2).toFixed(2)} ${(cy - height * 0.15).toFixed(2)}, ${cx.toFixed(2)} ${topY.toFixed(2)} Z" fill="#1f6cd6" />`
    }

    const buildSnowflake = (cx: number, cy: number, scale = 1) => {
      const radius = size * 0.14 * scale
      const strokeWidth = size * 0.035 * scale
      const diag = radius * 0.7
      return `
        <g stroke="#1f6cd6" stroke-width="${strokeWidth.toFixed(2)}" stroke-linecap="round">
          <line x1="${(cx - radius).toFixed(2)}" y1="${cy.toFixed(2)}" x2="${(cx + radius).toFixed(2)}" y2="${cy.toFixed(2)}" />
          <line x1="${cx.toFixed(2)}" y1="${(cy - radius).toFixed(2)}" x2="${cx.toFixed(2)}" y2="${(cy + radius).toFixed(2)}" />
          <line x1="${(cx - diag).toFixed(2)}" y1="${(cy - diag).toFixed(2)}" x2="${(cx + diag).toFixed(2)}" y2="${(cy + diag).toFixed(2)}" />
          <line x1="${(cx - diag).toFixed(2)}" y1="${(cy + diag).toFixed(2)}" x2="${(cx + diag).toFixed(2)}" y2="${(cy - diag).toFixed(2)}" />
        </g>
      `
    }

    const buildFog = () => {
      const lines: string[] = []
      const startY = center - size * 0.12
      for (let i = 0; i < 3; i++) {
        const y = startY + i * size * 0.1
        lines.push(`<line x1="${(center - size * 0.35).toFixed(2)}" y1="${y.toFixed(2)}" x2="${(center + size * 0.35).toFixed(2)}" y2="${y.toFixed(2)}" stroke="#c1c8d2" stroke-width="${stroke.toFixed(2)}" stroke-linecap="round" />`)
      }
      return lines.join('')
    }

    const cloudCenterY = center + size * 0.05

    switch (category) {
      case 'clear':
        return `<g>${buildSun(center, center)}</g>`
      case 'partly':
        return `
          <g>
            ${buildSun(center - size * 0.15, center - size * 0.12, 0.32)}
            ${buildCloud(center + size * 0.05, cloudCenterY, 0.92)}
          </g>
        `
      case 'cloudy':
        return `<g>${buildCloud(center, cloudCenterY, 1.05)}</g>`
      case 'rain':
        return `
          <g>
            ${buildCloud(center, cloudCenterY, 1)}
            <g>
              ${buildRaindrop(center - size * 0.18, cloudCenterY + size * 0.45, 0.9)}
              ${buildRaindrop(center, cloudCenterY + size * 0.5, 1)}
              ${buildRaindrop(center + size * 0.18, cloudCenterY + size * 0.45, 0.9)}
            </g>
          </g>
        `
      case 'snow':
        return `
          <g>
            ${buildCloud(center, cloudCenterY, 1)}
            <g>
              ${buildSnowflake(center - size * 0.18, cloudCenterY + size * 0.5, 0.7)}
              ${buildSnowflake(center, cloudCenterY + size * 0.55, 0.75)}
              ${buildSnowflake(center + size * 0.18, cloudCenterY + size * 0.5, 0.7)}
            </g>
          </g>
        `
      case 'sleet':
        return `
          <g>
            ${buildCloud(center, cloudCenterY, 1)}
            ${buildRaindrop(center - size * 0.14, cloudCenterY + size * 0.48, 0.9)}
            ${buildSnowflake(center + size * 0.16, cloudCenterY + size * 0.5, 0.6)}
          </g>
        `
      case 'fog':
        return `
          <g>
            ${buildCloud(center, cloudCenterY, 0.9)}
            ${buildFog()}
          </g>
        `
      default:
        return `<g>${buildCloud(center, cloudCenterY, 1)}</g>`
    }
  }

  private resolveFetchTarget = (normalizedUrl: string): FetchTarget | null => {
    try {
      const parsed = new URL(normalizedUrl)
      const host = parsed.hostname.toLowerCase()
      const yrHost = host === 'www.yr.no' || host.endsWith('.yr.no')
      if (yrHost) {
        const decodedPath = decodeURIComponent(parsed.pathname)
        const segments = decodedPath.split('/').filter(Boolean)
        const contentIndex = segments.findIndex((segment) => segment.toLowerCase() === 'content')
        if (contentIndex >= 0 && segments.length > contentIndex + 2) {
          const locationSegment = segments[contentIndex + 1]
          const resourceSegment = segments[contentIndex + 2]
          if (/meteogram\.svg$/i.test(resourceSegment)) {
            const coordParts = locationSegment.split(',')
            if (coordParts.length >= 2) {
              const lat = Number.parseFloat(coordParts[0])
              const lon = Number.parseFloat(coordParts[1])
              const latString = this.truncateCoordinate(lat)
              const lonString = this.truncateCoordinate(lon)
              if (latString && lonString) {
                const params = new URLSearchParams()
                parsed.searchParams.forEach((value, key) => {
                  if (key.toLowerCase() === 'nocache') return
                  if (key.toLowerCase() === 'altitude') {
                    params.set('altitude', value)
                    return
                  }
                })
                params.set('lat', latString)
                params.set('lon', lonString)
                const altitude = params.get('altitude')
                const altitudeFragment = altitude ? `&altitude=${encodeURIComponent(altitude)}` : ''
                const apiUrl = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${encodeURIComponent(latString)}&lon=${encodeURIComponent(lonString)}${altitudeFragment}`
                return { requestUrl: apiUrl, kind: 'locationforecast' }
              }
            }
          }
        }
      }
      if (host === 'api.met.no') {
        const path = parsed.pathname.toLowerCase()
        if (path.includes('/weatherapi/locationforecast/2.0/')) {
          return { requestUrl: parsed.toString(), kind: 'locationforecast' }
        }
        if (path.endsWith('/meteogram/2.0/classic')) {
          const urlObj = new URL(parsed.toString())
          const lat = urlObj.searchParams.get('lat')
          const lon = urlObj.searchParams.get('lon')
          const latString = this.truncateCoordinate(Number.parseFloat(lat ?? ''))
          const lonString = this.truncateCoordinate(Number.parseFloat(lon ?? ''))
          const altitude = urlObj.searchParams.get('altitude')
          if (latString && lonString) {
            const altitudeFragment = altitude ? `&altitude=${encodeURIComponent(altitude)}` : ''
            const apiUrl = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${encodeURIComponent(latString)}&lon=${encodeURIComponent(lonString)}${altitudeFragment}`
            return { requestUrl: apiUrl, kind: 'locationforecast' }
          }
        }
      }
      return { requestUrl: parsed.toString(), kind: 'svg' }
    } catch (err) {
      // ignore resolution errors and fall back to the normalized URL
    }
    return { requestUrl: normalizedUrl, kind: 'svg' }
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

    if (effectiveUrl !== this.lastSourceInput) {
      this.lastModifiedHeader = null
      this.lastEtagHeader = null
      this.lastRequestUrl = null
      this.lastSourceInput = effectiveUrl
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
    const effectiveUrl = this.getEffectiveSourceInput()
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
    const fetchTarget = this.resolveFetchTarget(normalizedUrl)
    if (!fetchTarget) {
      this.setState({
        isLoading: false,
        error: 'Unable to resolve a meteogram endpoint from the provided Source URL.'
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
    if (fetchTarget.requestUrl !== this.lastRequestUrl) {
      this.lastModifiedHeader = null
      this.lastEtagHeader = null
      this.lastRequestUrl = fetchTarget.requestUrl
    }
    if (attempt === 1) {
      this.setState({ isLoading: true, error: null })
    }
    if (fetchTarget.kind === 'locationforecast') {
      this.fetchFromLocationForecast(fetchTarget.requestUrl, attempt)
    } else {
      this.fetchSvgDirect(fetchTarget.requestUrl, attempt)
    }
  }

  private fetchFromLocationForecast = (url: string, attempt = 1): void => {
    const hasConditionalHeaders = Boolean(this.lastModifiedHeader || this.lastEtagHeader)
    const requestUrl = url
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    if (controller) {
      timeoutId = setTimeout(() => controller.abort(), 15000)
    }

    const headers = new Headers({ Accept: 'application/json' })
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
      .then(async r => {
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
        return r.json()
      })
      .then(json => {
        if (!json) {
          return
        }
        const svgString = this.buildSvgFromLocationForecast(json)
        this.processSvg(svgString)
        if (svgString.startsWith('<svg')) {
          this.applyConfigUpdate(cfg => cfg.set('svgCode', svgString), 'store fetched SVG from Locationforecast')
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
          setTimeout(() => this.fetchFromLocationForecast(url, attempt + 1), 1000 * attempt)
          return
        }
        console.error('Failed to fetch Locationforecast data:', err)
        const fallback = this.state.rawSvg || this.getFallbackSvg()
        if (fallback && fallback.trim().startsWith('<svg')) {
          this.processSvg(fallback)
          return
        }
        this.setState({
          isLoading: false,
          error: 'Unable to load forecast data from source.'
        })
      })
      .finally(() => {
        if (timeoutId) clearTimeout(timeoutId)
      })
  }

  private computeChartYPosition = (value: number, min: number, range: number, height: number, top: number): number => {
    if (!Number.isFinite(value)) {
      return height + top
    }
    if (range === 0) {
      return top + height / 2
    }
    const normalized = (value - min) / range
    return top + height - (normalized * height)
  }


  private buildSvgFromLocationForecast = (forecastJson: any): string => {
    const timeseries = forecastJson?.properties?.timeseries
    if (!Array.isArray(timeseries) || timeseries.length === 0) {
      throw new Error('Locationforecast response does not contain any timeseries data.')
    }

    const series = timeseries.slice(0, 60)

    const points: ForecastPoint[] = series
      .map((entry) => {
        const isoTime = entry?.time
        const date = isoTime ? new Date(isoTime) : null
        const details = entry?.data?.instant?.details ?? {}
        const next1Hour = entry?.data?.next_1_hours
        const next6Hour = entry?.data?.next_6_hours
        const next12Hour = entry?.data?.next_12_hours

        let precipitationValue = Number(next1Hour?.details?.precipitation_amount)
        if (!Number.isFinite(precipitationValue)) {
          const sixHourValue = Number(next6Hour?.details?.precipitation_amount)
          if (Number.isFinite(sixHourValue)) {
            precipitationValue = sixHourValue / 6
          } else {
            const twelveHourValue = Number(next12Hour?.details?.precipitation_amount)
            precipitationValue = Number.isFinite(twelveHourValue) ? twelveHourValue / 12 : 0
          }
        }

        const temperatureRaw = Number(details?.air_temperature)
        const windSpeedRaw = Number(details?.wind_speed)
        const windGustRaw = Number(details?.wind_speed_of_gust)

        return {
          date,
          temperature: Number.isFinite(temperatureRaw) ? temperatureRaw : null,
          windSpeed: Number.isFinite(windSpeedRaw) ? windSpeedRaw : null,
          windGust: Number.isFinite(windGustRaw) ? windGustRaw : null,
          precipitation: Number.isFinite(precipitationValue) ? Math.max(precipitationValue, 0) : 0,
          symbolCode: next1Hour?.summary?.symbol_code ?? next6Hour?.summary?.symbol_code ?? next12Hour?.summary?.symbol_code ?? null
        }
      })
      .filter((p): p is ForecastPoint => p.date instanceof Date && !Number.isNaN(p.date.getTime()))

    if (points.length < 2) {
      throw new Error('Unable to parse any valid forecast points from Locationforecast response.')
    }

    const temperatures = points.map(p => p.temperature).filter((v): v is number => typeof v === 'number')
    const windSpeeds = points.map(p => p.windSpeed).filter((v): v is number => typeof v === 'number')
    const precipitationValues = points.map(p => Math.max(p.precipitation ?? 0, 0))

    const minTemp = temperatures.length ? Math.min(...temperatures) : -5
    const maxTemp = temperatures.length ? Math.max(...temperatures) : 5
    let tempMin = Math.floor((minTemp - 2) / 2) * 2
    let tempMax = Math.ceil((maxTemp + 2) / 2) * 2
    if (tempMin === tempMax) {
      tempMin -= 2
      tempMax += 2
    }
    const tempRange = tempMax - tempMin

    const maxWindObserved = windSpeeds.length ? Math.max(...windSpeeds) : 0
    let windScaleMax = Math.max(4, Math.ceil((maxWindObserved + 1)))
    if (windScaleMax === 0) windScaleMax = 4

    const maxPrecipObserved = precipitationValues.length ? Math.max(...precipitationValues) : 0
    const computePrecipStep = (value: number): number => {
      if (value <= 0.4) return 0.2
      if (value <= 1.5) return 0.5
      if (value <= 4) return 1
      if (value <= 8) return 2
      if (value <= 15) return 3
      if (value <= 25) return 5
      return 10
    }
    const precipStep = computePrecipStep(maxPrecipObserved)
    let precipScaleMax = maxPrecipObserved > 0 ? Math.ceil(maxPrecipObserved / precipStep) * precipStep : Math.max(1, precipStep * 3)
    if (precipScaleMax <= 0) {
      precipScaleMax = 1
    }

    const width = 782
    const height = 391
    const marginLeft = 70
    const marginRight = 70
    const chartWidth = width - marginLeft - marginRight

    const tempAreaTop = 140
    const tempAreaHeight = 120
    const precipAreaTop = tempAreaTop + tempAreaHeight
    const precipAreaHeight = 60
    const windAreaTop = precipAreaTop + precipAreaHeight
    const windAreaHeight = 45
    const chartBottom = windAreaTop + windAreaHeight
    const bottomLabelY = chartBottom + 18
    const iconRowY = tempAreaTop - 56
    const dayLabelY = tempAreaTop - 22

    const step = chartWidth / (points.length - 1)
    const getX = (idx: number) => marginLeft + step * idx
    const getSegmentLeft = (idx: number) => idx <= 0 ? marginLeft : (getX(idx) + getX(idx - 1)) / 2
    const getSegmentRight = (idx: number) => idx >= points.length - 1 ? marginLeft + chartWidth : (getX(idx) + getX(idx + 1)) / 2

    const tempY = (value: number) => tempAreaTop + (tempMax - value) / tempRange * tempAreaHeight
    const windY = (value: number) => windAreaTop + (windScaleMax - Math.min(value, windScaleMax)) / windScaleMax * windAreaHeight

    const formatValue = (value: number, allowTenths = false): string => {
      if (allowTenths) {
        return value.toFixed(1).replace(/\.0$/, '')
      }
      return value.toFixed(0)
    }

    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const formatDayLabel = (date: Date) => `${weekdays[date.getDay()]} ${date.getDate()} ${months[date.getMonth()]}`

    const daySegments: Array<{ key: string, startIndex: number, endIndex: number, label: string }> = []
    points.forEach((point, idx) => {
      const d = point.date
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
      if (!daySegments.length || daySegments[daySegments.length - 1].key !== key) {
        daySegments.push({ key, startIndex: idx, endIndex: idx, label: formatDayLabel(d) })
      } else {
        daySegments[daySegments.length - 1].endIndex = idx
      }
    })

    const dayBackgrounds: string[] = []
    const dayLabels: string[] = []
    const dayBoundaryLines: string[] = []
    daySegments.forEach((segment, segmentIndex) => {
      const startX = getSegmentLeft(segment.startIndex)
      const endX = getSegmentRight(segment.endIndex)
      const fill = segmentIndex % 2 === 0 ? '#f5f7fa' : '#ffffff'
      dayBackgrounds.push(`<rect x="${startX.toFixed(2)}" y="${tempAreaTop.toFixed(2)}" width="${(endX - startX).toFixed(2)}" height="${(chartBottom - tempAreaTop).toFixed(2)}" fill="${fill}" opacity="0.7" />`)
      dayLabels.push(`<text class="day-label" x="${((startX + endX) / 2).toFixed(2)}" y="${dayLabelY.toFixed(2)}" text-anchor="middle">${this.escapeXml(segment.label)}</text>`)
      if (segmentIndex > 0) {
        const boundaryX = startX
        dayBoundaryLines.push(`<line x1="${boundaryX.toFixed(2)}" y1="${tempAreaTop.toFixed(2)}" x2="${boundaryX.toFixed(2)}" y2="${chartBottom.toFixed(2)}" stroke="#c3d0d8" stroke-width="1" stroke-dasharray="4 4" />`)
      }
    })

    const horizontalLines: string[] = []
    const temperatureLabels: string[] = []
    for (let i = 0; i <= 4; i++) {
      const value = tempMin + (tempRange / 4) * i
      const y = tempY(value)
      horizontalLines.push(`<line x1="${marginLeft.toFixed(2)}" y1="${y.toFixed(2)}" x2="${(width - marginRight).toFixed(2)}" y2="${y.toFixed(2)}" stroke="#c3d0d8" stroke-width="1" />`)
      temperatureLabels.push(`<text class="y-axis-label temperature-label" x="${(marginLeft - 12).toFixed(2)}" y="${(y + 4).toFixed(2)}" text-anchor="end">${formatValue(value, true)}°C</text>`)
    }

    const verticalLines: string[] = []
    const hourTicks: string[] = []
    const hourLabels: string[] = []
    const hourInterval = points.length > 48 ? 6 : 3
    points.forEach((point, idx) => {
      if (point.date.getMinutes() !== 0) return
      const hours = point.date.getHours()
      if (idx !== 0 && idx !== points.length - 1 && hours % hourInterval !== 0) {
        return
      }
      const x = getX(idx)
      verticalLines.push(`<line x1="${x.toFixed(2)}" y1="${tempAreaTop.toFixed(2)}" x2="${x.toFixed(2)}" y2="${chartBottom.toFixed(2)}" stroke="#e2e6ec" stroke-width="1" stroke-dasharray="2 6" />`)
      hourTicks.push(`<line x1="${x.toFixed(2)}" y1="${chartBottom.toFixed(2)}" x2="${x.toFixed(2)}" y2="${(chartBottom + 6).toFixed(2)}" stroke="#c3d0d8" stroke-width="1" />`)
      hourLabels.push(`<text class="hour-label" x="${x.toFixed(2)}" y="${bottomLabelY.toFixed(2)}" text-anchor="middle">${hours.toString().padStart(2, '0')}</text>`)
    })

    const temperaturePathPoints: string[] = []
    points.forEach((point, idx) => {
      if (typeof point.temperature !== 'number') return
      const x = getX(idx)
      const y = tempY(point.temperature)
      temperaturePathPoints.push(`${temperaturePathPoints.length === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`)
    })
    const temperaturePath = temperaturePathPoints.length > 1 ? `<path d="${temperaturePathPoints.join(' ')}" fill="none" stroke="#c60000" stroke-width="2.5" />` : ''

    const windPathPoints: string[] = []
    points.forEach((point, idx) => {
      if (typeof point.windSpeed !== 'number') return
      const x = getX(idx)
      const y = windY(point.windSpeed)
      windPathPoints.push(`${windPathPoints.length === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`)
    })
    const windPath = windPathPoints.length > 1 ? `<path d="${windPathPoints.join(' ')}" fill="none" stroke="#aa00f2" stroke-width="2" />` : ''

    const precipitationRects: string[] = []
    const precipitationLabels: string[] = []
    points.forEach((point, idx) => {
      if (!point.precipitation || point.precipitation <= 0) return
      const xCenter = getX(idx)
      const barWidth = Math.min(step * 0.6, 18)
      const barHeight = Math.min(point.precipitation, precipScaleMax) / precipScaleMax * precipAreaHeight
      const y = precipAreaTop + (precipAreaHeight - barHeight)
      precipitationRects.push(`<rect x="${(xCenter - barWidth / 2).toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${barHeight.toFixed(2)}" fill="#006edb" />`)
      if (point.precipitation > precipScaleMax) {
        precipitationLabels.push(`<text class="precipitation-values-over-max" x="${xCenter.toFixed(2)}" y="${(y - 6).toFixed(2)}" text-anchor="middle">${point.precipitation.toFixed(1)} mm</text>`)
      }
    })

    const precipAxisLabels: string[] = []
    for (let i = 0; i <= 4; i++) {
      const value = (precipScaleMax / 4) * i
      const y = precipAreaTop + (precipAreaHeight - (value / precipScaleMax) * precipAreaHeight)
      precipAxisLabels.push(`<text class="y-axis-label precipitation-label" x="${(width - marginRight + 18).toFixed(2)}" y="${(y + 4).toFixed(2)}" text-anchor="start">${value.toFixed(value < 1 ? 1 : 0)} mm</text>`)
    }

    const windAxisLabels: string[] = []
    for (let i = 0; i <= 3; i++) {
      const value = (windScaleMax / 3) * i
      const y = windAreaTop + (windAreaHeight - (value / windScaleMax) * windAreaHeight)
      windAxisLabels.push(`<text class="y-axis-label wind-label" x="${(width - marginRight + 18).toFixed(2)}" y="${(y + 4).toFixed(2)}" text-anchor="start">${value.toFixed(value < 10 ? 1 : 0)} m/s</text>`)
    }

    const iconInterval = Math.max(1, Math.round(points.length / 18))
    const iconElements: string[] = []
    const iconSize = 34
    points.forEach((point, idx) => {
      if (idx % iconInterval !== 0 && idx !== points.length - 1) return
      const category = this.getWeatherSymbolCategory(point.symbolCode)
      const iconSvg = this.buildWeatherIconSvg(category, iconSize)
      const x = getX(idx) - iconSize / 2
      const y = iconRowY - iconSize / 2
      iconElements.push(`<g class="weather-icon" transform="translate(${x.toFixed(2)}, ${y.toFixed(2)})">${iconSvg}</g>`)
    })

    const axisBaseline = `<line x1="${marginLeft.toFixed(2)}" y1="${chartBottom.toFixed(2)}" x2="${(width - marginRight).toFixed(2)}" y2="${chartBottom.toFixed(2)}" stroke="#c3d0d8" stroke-width="1" />`

    const legendX = width - marginRight - 150
    const legendY = tempAreaTop - 18
    const legendGroup = `
      <g class="legend" transform="translate(${legendX}, ${legendY})">
        <g>
          <line x1="0" y1="0" x2="22" y2="0" stroke="#c60000" stroke-width="2" />
          <text class="legend-label" x="28" y="4">Temperature</text>
        </g>
        <g transform="translate(0, 18)">
          <rect x="0" y="-10" width="22" height="10" fill="#006edb" />
          <text class="legend-label" x="28" y="-2">Precipitation</text>
        </g>
        <g transform="translate(0, 36)">
          <line x1="0" y1="0" x2="22" y2="0" stroke="#aa00f2" stroke-width="2" />
          <text class="legend-label" x="28" y="4">Wind</text>
        </g>
      </g>
    `

    const coords = Array.isArray(forecastJson?.geometry?.coordinates) ? forecastJson.geometry.coordinates : null
    const lon = typeof coords?.[0] === 'number' ? coords[0] : null
    const lat = typeof coords?.[1] === 'number' ? coords[1] : null
    const latLabel = this.formatCoordinateForLabel(lat)
    const lonLabel = this.formatCoordinateForLabel(lon)
    const locationTitle = latLabel && lonLabel ? `Weather forecast for ${latLabel}, ${lonLabel}` : 'Weather forecast'

    const styleBlock = `
<style>
  text {
    font-family: NRK Sans Variable, -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif;
  }
  .location-header {
    font-size: 1.4666666667rem;
    font-weight: 600;
    line-height: 1.8333333333rem;
    letter-spacing: -0.22px;
  }
  .served-by-header {
    font-size: 0.8666666667rem;
    font-weight: 600;
    line-height: 1.2rem;
  }
  .day-label {
    font-size: 1.0666666667rem;
    font-weight: 600;
    line-height: 1.4666666667rem;
  }
  .hour-label,
  .y-axis-label,
  .legend-label {
    font-size: 0.8666666667rem;
    font-weight: 440;
    line-height: 1.2rem;
  }
  .precipitation-values-over-max {
    font-size: 0.8rem;
    font-weight: 600;
    line-height: 1rem;
    fill: #ffffff;
  }
  .hour-label,
  .y-axis-label,
  .legend-label {
    fill: #56616c;
  }
  .location-header,
  .served-by-header,
  .day-label {
    fill: #21292b;
  }
</style>
`

    const defs = `
      <defs>
        <pattern id="max-precipitation-pattern" patternUnits="userSpaceOnUse" width="4" height="4">
          <rect x="0" y="0" width="4" height="4" fill="#006edb" opacity="0.3" />
          <line x1="0" y1="0" x2="4" y2="4" stroke="#006edb" stroke-width="0.5" opacity="0.6" />
          <line x1="4" y1="0" x2="0" y2="4" stroke="#006edb" stroke-width="0.5" opacity="0.6" />
        </pattern>
      </defs>
    `

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Yr Weather Forecast">
  ${styleBlock}
  <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" />
  ${defs}
  <svg x="16" y="16" width="30" height="30">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <circle fill="#00b9f1" cx="50" cy="50" r="50"/>
      <g>
        <path fill="#FFFFFF" d="M80,64.4c-1.7-1.8-4.4-5.5-4.4-5.5c2.4-0.7,4.5-1.9,6.2-3.6c2.7-2.7,4.2-6.6,4.2-10.7c0-4.3-1.9-8.2-4.8-10.6c-3-2.4-6.8-3.6-10.8-3.6h-7c-6.6,0-11.9,5.3-11.9,11.9v29.5h8v-8.4c0-2.2,1.8-4,4-4h3.2l0,0L75.1,70l0.6,0.7c0.6,0.6,1.5,1,2.4,1.1v0h0.2c0.1,0,0.1,0,0.2,0s0.1,0,0.2,0h4.7l0-6.4C83.4,65.4,81.4,66,80,64.4z M71.1,51.6h-7.7c-1.4,0-2.7,0.6-4,1V42.4c0-2.2,1.8-4,4-4h7c2.5,0,4.5,0.7,5.7,1.8c1.2,1.1,1.9,2.3,2,4.5c0,2.3-0.8,3.9-1.9,5.1C75,50.8,73.4,51.6,71.1,51.6z"/>
        <path fill="#FFFFFF" d="M46.3,31.8h-7.9l0,12.9c-0.2,4.8-4.6,6.4-8.2,6.4c-4.1-0.1-8.4-2.3-8.4-8.6V31.8H14v10.7c0,4.9,1.7,9,4.9,12c2.9,2.7,6.8,4.2,11.1,4.3l0,0c0.1,0,0.1,0,0.2,0s0.1,0,0.2,0l0,0c2.9-0.1,7.1-1.9,8-3.6v3.5c0,4.7-6,7.8-7.6,8.6l0.1,0.1c0,0-0.1,0-0.1,0.1l5,6c2.9-1.7,10.5-5.1,10.5-15.7V31.8L46.3,31.8z"/>
      </g>
    </svg>
  </svg>
  <text class="location-header" x="70" y="44">${this.escapeXml(locationTitle)}</text>
  <g transform="translate(${width - 170}, 34)">
    <text class="served-by-header" x="90" y="0" text-anchor="end">Served by</text>
  </g>
  <svg x="${width - 158}" y="24.28" width="39.5" height="13.941176470588236" filter="none">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 68 24">
      <path fill="currentColor" fill-rule="evenodd" d="M18.662 4.234C18.24 2.077 16.352.451 14.09.451H8.783L14.113 24h8.97l-4.42-19.766zM0 24h8.237V.45H.001V24zm23.677 0h8.253V.45h-8.253V24zM37.174 0c-2.582 0-4.675 2.11-4.675 4.715s2.093 4.723 4.675 4.723c2.588 0 4.689-2.118 4.689-4.723 0-2.604-2.101-4.714-4.69-4.714zm5.206 24h8.26V.45h-8.26V24zm18.634-10.677c-.496-.835-.52-1.35-.046-2.158L67.514.451h-9.08s-5.457 8.914-6.203 10.152c-.74 1.238-.706 2.008.031 3.28C53.008 15.15 58.434 24 58.434 24h9.08s-6.427-10.546-6.5-10.678z" clip-rule="evenodd"/>
    </svg>
  </svg>
  <svg x="${width - 106.5}" y="20" width="82.5" height="22.247191011235955" filter="none">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 89 24">
      <path fill="currentColor" d="M0 0h7.5l5.92 12.58L19.34 0h7.36L12.81 24h-7.5L0 0Zm52.76 0L39.78 24h7.5l2.12-4.37h13.7L65.22 24h7.5L59.77 0h-7.01Zm-0.24 13.78h-8.22l4.08-8.68 4.14 8.68Zm24.66-2.67c2.48-.98 4.16-3.02 4.16-5.86C81.34 2.37 78.14 0 73.35 0H60.46v24h7.34v-8.93h4.43l4.78 8.93H85.8l-8.62-14.96Zm-5.92-3.7h-2.36V6.12h2.36c1.5 0 2.28.66 2.28 1.92 0 1.26-.78 1.87-2.28 1.87Z"/>
    </svg>
  </svg>
  <g>
    ${dayBackgrounds.join('')}
    ${dayBoundaryLines.join('')}
    ${horizontalLines.join('')}
    ${verticalLines.join('')}
    ${temperaturePath}
    ${precipitationRects.join('')}
    ${precipitationLabels.join('')}
    ${axisBaseline}
    ${windPath}
    ${legendGroup}
    ${temperatureLabels.join('')}
    ${precipAxisLabels.join('')}
    ${windAxisLabels.join('')}
    ${hourTicks.join('')}
    ${hourLabels.join('')}
    ${dayLabels.join('')}
    ${iconElements.join('')}
  </g>
</svg>`
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
    const effectiveSourceUrl = this.getEffectiveSourceInput()

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

    const effectiveSourceUrl = this.getEffectiveSourceInput()
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
