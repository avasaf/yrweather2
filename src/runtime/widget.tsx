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
  windDirection: number | null
  precipitation: number
  precipitationMax: number
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

        const precipitationSources: Array<{ details: any, hours: number }> = [
          { details: next1Hour?.details, hours: 1 },
          { details: next6Hour?.details, hours: 6 },
          { details: next12Hour?.details, hours: 12 }
        ]

        let precipitationValue = 0
        let precipitationMaxValue = 0
        for (const source of precipitationSources) {
          if (!source?.details) continue
          const amount = Number(source.details?.precipitation_amount)
          if (!Number.isFinite(amount)) continue
          const normalized = amount / Math.max(1, source.hours)
          precipitationValue = Math.max(normalized, 0)

          const maxAmount = Number(source.details?.precipitation_amount_max)
          if (Number.isFinite(maxAmount)) {
            precipitationMaxValue = Math.max(maxAmount / Math.max(1, source.hours), precipitationValue)
          }
          break
        }

        if (!Number.isFinite(precipitationMaxValue) || precipitationMaxValue <= 0) {
          precipitationMaxValue = precipitationValue
        } else if (precipitationValue > precipitationMaxValue) {
          precipitationMaxValue = precipitationValue
        }

        const temperatureRaw = Number(details?.air_temperature)
        const windSpeedRaw = Number(details?.wind_speed)
        const windGustRaw = Number(details?.wind_speed_of_gust)
        const windDirectionRaw = Number(details?.wind_from_direction)

        return {
          date,
          temperature: Number.isFinite(temperatureRaw) ? temperatureRaw : null,
          windSpeed: Number.isFinite(windSpeedRaw) ? windSpeedRaw : null,
          windGust: Number.isFinite(windGustRaw) ? windGustRaw : null,
          windDirection: Number.isFinite(windDirectionRaw) ? ((windDirectionRaw % 360) + 360) % 360 : null,
          precipitation: Number.isFinite(precipitationValue) ? Math.max(precipitationValue, 0) : 0,
          precipitationMax: Number.isFinite(precipitationMaxValue) ? Math.max(precipitationMaxValue, 0) : Math.max(precipitationValue, 0),
          symbolCode: next1Hour?.summary?.symbol_code ?? next6Hour?.summary?.symbol_code ?? next12Hour?.summary?.symbol_code ?? null
        }
      })
      .filter((p): p is ForecastPoint => p.date instanceof Date && !Number.isNaN(p.date.getTime()))

    if (points.length < 2) {
      throw new Error('Unable to parse any valid forecast points from Locationforecast response.')
    }

    const config = this.props.config

    const temperatures = points.map(p => p.temperature).filter((v): v is number => typeof v === 'number')
    const windSpeeds = points.map(p => p.windSpeed).filter((v): v is number => typeof v === 'number')
    const windGusts = points.map(p => p.windGust).filter((v): v is number => typeof v === 'number')
    const precipitationValues = points.map(p => Math.max(p.precipitation ?? 0, 0))
    const precipitationMaxValues = points.map(p => Math.max(p.precipitationMax ?? 0, 0))

    const minTemp = temperatures.length ? Math.min(...temperatures) : -5
    const maxTemp = temperatures.length ? Math.max(...temperatures) : 5
    let tempMin = Math.floor((minTemp - 2) / 2) * 2
    let tempMax = Math.ceil((maxTemp + 2) / 2) * 2
    if (tempMin === tempMax) {
      tempMin -= 2
      tempMax += 2
    }
    const tempRange = tempMax - tempMin

    const maxWindObserved = Math.max(
      windSpeeds.length ? Math.max(...windSpeeds) : 0,
      windGusts.length ? Math.max(...windGusts) : 0
    )
    let windScaleMax = Math.max(4, Math.ceil((maxWindObserved + 1)))
    if (windScaleMax === 0) windScaleMax = 4

    const maxPrecipObserved = Math.max(
      precipitationValues.length ? Math.max(...precipitationValues) : 0,
      precipitationMaxValues.length ? Math.max(...precipitationMaxValues) : 0
    )
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
    const marginLeft = 72
    const marginRight = 92
    const chartWidth = width - marginLeft - marginRight

    const dayLabelY = 48
    const hourLabelY = dayLabelY + 22
    const weatherTop = hourLabelY + 52
    const weatherHeight = 210
    const weatherBottom = weatherTop + weatherHeight
    const precipAreaHeight = Math.min(80, weatherHeight * 0.38)
    const precipAreaTop = weatherBottom - precipAreaHeight
    const windGap = 30
    const windAreaTop = weatherBottom + windGap
    const windAreaHeight = 120
    const windAreaBottom = windAreaTop + windAreaHeight
    const iconRowY = weatherTop - 36
    const arrowRowY = windAreaBottom + 26
    const legendY = arrowRowY + 26
    const titleY = legendY + 46
    const height = titleY + 36

    const step = chartWidth / (points.length - 1)
    const getX = (idx: number) => marginLeft + step * idx
    const getSegmentLeft = (idx: number) => idx <= 0 ? marginLeft : (getX(idx) + getX(idx - 1)) / 2
    const getSegmentRight = (idx: number) => idx >= points.length - 1 ? marginLeft + chartWidth : (getX(idx) + getX(idx + 1)) / 2

    const tempY = (value: number) => weatherTop + (tempMax - value) / tempRange * weatherHeight
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

    const dayLabels: string[] = []
    const dayBoundaryLines: string[] = []
    daySegments.forEach((segment, segmentIndex) => {
      const startX = getSegmentLeft(segment.startIndex)
      const endX = getSegmentRight(segment.endIndex)
      dayLabels.push(`<text class="day-label" x="${((startX + endX) / 2).toFixed(2)}" y="${dayLabelY.toFixed(2)}" text-anchor="middle">${this.escapeXml(segment.label)}</text>`)
      if (segmentIndex > 0) {
        const boundaryX = startX
        const dayBoundaryColor = config?.dayBoundaryColor ?? '#c3d0d8'
        const dayBoundaryWidth = typeof config?.dayBoundaryWidth === 'number' ? config.dayBoundaryWidth : 2
        const rawOpacity = typeof config?.dayBoundaryOpacity === 'number' ? config.dayBoundaryOpacity : 0.6
        const dayBoundaryOpacity = Number.isFinite(rawOpacity) ? Math.min(Math.max(rawOpacity, 0), 1) : 0.6
        dayBoundaryLines.push(`<line x1="${boundaryX.toFixed(2)}" y1="${weatherTop.toFixed(2)}" x2="${boundaryX.toFixed(2)}" y2="${windAreaBottom.toFixed(2)}" stroke="${dayBoundaryColor}" stroke-width="${dayBoundaryWidth}" stroke-opacity="${dayBoundaryOpacity}" />`)
      }
    })

    const horizontalLines: string[] = []
    const temperatureLabels: string[] = []
    for (let i = 0; i <= 4; i++) {
      const value = tempMin + (tempRange / 4) * i
      const y = tempY(value)
      horizontalLines.push(`<line x1="${marginLeft.toFixed(2)}" y1="${y.toFixed(2)}" x2="${(width - marginRight).toFixed(2)}" y2="${y.toFixed(2)}" stroke="${config?.gridLineColor ?? '#c3d0d8'}" stroke-width="${(typeof config?.gridLineWidth === 'number' ? config.gridLineWidth : 1).toFixed(2)}" stroke-opacity="${Number.isFinite(config?.gridLineOpacity) ? Math.min(Math.max(config.gridLineOpacity, 0), 1) : 1}" />`)
      temperatureLabels.push(`<text class="y-axis-label temperature-label" x="${(marginLeft - 16).toFixed(2)}" y="${(y - 6).toFixed(2)}" text-anchor="end" dominant-baseline="alphabetic">${formatValue(value, true)}°C</text>`)
    }

    const windHorizontalLines: string[] = []
    const windAxisLabels: string[] = []
    const windLabelSteps = 3
    for (let i = 0; i <= windLabelSteps; i++) {
      const value = (windScaleMax / windLabelSteps) * i
      const y = windY(value)
      windHorizontalLines.push(`<line x1="${marginLeft.toFixed(2)}" y1="${y.toFixed(2)}" x2="${(width - marginRight).toFixed(2)}" y2="${y.toFixed(2)}" stroke="${config?.gridLineColor ?? '#c3d0d8'}" stroke-width="${(typeof config?.gridLineWidth === 'number' ? config.gridLineWidth : 1).toFixed(2)}" stroke-opacity="${(Number.isFinite(config?.gridLineOpacity) ? Math.min(Math.max(config.gridLineOpacity, 0), 1) : 1) * 0.9}" />`)
      const clampedY = Math.min(windAreaBottom - 4, y + 10)
      windAxisLabels.push(`<text class="y-axis-label wind-label" x="${(marginLeft - 16).toFixed(2)}" y="${clampedY.toFixed(2)}" text-anchor="end" dominant-baseline="alphabetic">${value.toFixed(value < 10 ? 1 : 0)}</text>`)
    }

    const verticalLines: string[] = []
    const hourLabels: string[] = []
    points.forEach((point, idx) => {
      if (point.date.getMinutes() !== 0) return
      const hours = point.date.getHours()
      if (hours % 2 !== 0) return
      const x = getX(idx)
      const gridColor = config?.gridLineColor ?? '#c3d0d8'
      const gridWidth = typeof config?.gridLineWidth === 'number' ? config.gridLineWidth : 1
      const gridOpacity = Number.isFinite(config?.gridLineOpacity) ? Math.min(Math.max(config.gridLineOpacity, 0), 1) : 1
      verticalLines.push(`<line x1="${x.toFixed(2)}" y1="${weatherTop.toFixed(2)}" x2="${x.toFixed(2)}" y2="${windAreaBottom.toFixed(2)}" stroke="${gridColor}" stroke-width="${(gridWidth * 0.85).toFixed(2)}" stroke-opacity="${(gridOpacity * 0.75).toFixed(2)}" stroke-dasharray="2 6" />`)
      hourLabels.push(`<text class="hour-label" x="${x.toFixed(2)}" y="${hourLabelY.toFixed(2)}" text-anchor="middle">${hours.toString().padStart(2, '0')}:00</text>`)
    })

    const temperaturePathPoints: string[] = []
    points.forEach((point, idx) => {
      if (typeof point.temperature !== 'number') return
      const x = getX(idx)
      const y = tempY(point.temperature)
      temperaturePathPoints.push(`${temperaturePathPoints.length === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`)
    })
    const temperatureColor = config?.temperatureLineColor ?? '#c60000'
    const temperaturePath = temperaturePathPoints.length > 1 ? `<path d="${temperaturePathPoints.join(' ')}" fill="none" stroke="${temperatureColor}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />` : ''

    const windPathPoints: string[] = []
    points.forEach((point, idx) => {
      if (typeof point.windSpeed !== 'number') return
      const x = getX(idx)
      const y = windY(point.windSpeed)
      windPathPoints.push(`${windPathPoints.length === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`)
    })
    const windColor = config?.windLineColor ?? '#aa00f2'
    const windPath = windPathPoints.length > 1 ? `<path d="${windPathPoints.join(' ')}" fill="none" stroke="${windColor}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />` : ''

    const windGustPathPoints: string[] = []
    points.forEach((point, idx) => {
      if (typeof point.windGust !== 'number') return
      const x = getX(idx)
      const y = windY(point.windGust)
      windGustPathPoints.push(`${windGustPathPoints.length === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`)
    })
    const windGustColor = config?.windGustLineColor ?? '#e6d300'
    const windGustPath = windGustPathPoints.length > 1 ? `<path d="${windGustPathPoints.join(' ')}" fill="none" stroke="${windGustColor}" stroke-width="2" stroke-dasharray="4 4" stroke-linejoin="round" stroke-linecap="round" />` : ''

    const precipitationMaxRects: string[] = []
    const precipitationRects: string[] = []
    const precipitationLabels: string[] = []
    const precipColor = config?.precipitationBarColor ?? '#006edb'
    const precipMaxColor = config?.maxPrecipitationColor ?? '#00b8f1'
    points.forEach((point, idx) => {
      const xCenter = getX(idx)
      const barWidth = Math.min(step * 0.6, 18)
      const baseValue = Math.max(Math.min(point.precipitation ?? 0, precipScaleMax), 0)
      const maxValue = Math.max(Math.min(point.precipitationMax ?? baseValue, precipScaleMax), 0)
      if (maxValue > 0) {
        const maxHeight = (maxValue / precipScaleMax) * precipAreaHeight
        const maxY = precipAreaTop + (precipAreaHeight - maxHeight)
        precipitationMaxRects.push(`<rect x="${(xCenter - barWidth / 2).toFixed(2)}" y="${maxY.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${maxHeight.toFixed(2)}" fill="url(#max-precipitation-pattern)" stroke="${precipMaxColor}" stroke-width="0.6" />`)
      }
      if (baseValue > 0) {
        const baseHeight = (baseValue / precipScaleMax) * precipAreaHeight
        const baseY = precipAreaTop + (precipAreaHeight - baseHeight)
        precipitationRects.push(`<rect x="${(xCenter - barWidth / 2).toFixed(2)}" y="${baseY.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${baseHeight.toFixed(2)}" fill="${precipColor}" />`)
      }
      if (point.precipitation > precipScaleMax) {
        precipitationLabels.push(`<text class="precipitation-values-over-max" x="${xCenter.toFixed(2)}" y="${(precipAreaTop - 10).toFixed(2)}" text-anchor="middle">${point.precipitation.toFixed(1)} mm</text>`)
      }
    })

    const precipAxisLabels: string[] = []
    const precipTicks = 4
    for (let i = 0; i <= precipTicks; i++) {
      const value = (precipScaleMax / precipTicks) * i
      const y = precipAreaTop + (precipAreaHeight - (value / precipScaleMax) * precipAreaHeight)
      precipAxisLabels.push(`<text class="y-axis-label precipitation-label" x="${(width - marginRight + 18).toFixed(2)}" y="${(Math.max(weatherTop + 6, y - 6)).toFixed(2)}" dominant-baseline="hanging" text-anchor="start">${value.toFixed(value < 1 ? 1 : 0)}</text>`)
    }

    const iconInterval = Math.max(1, Math.round(points.length / 18))
    const iconElements: string[] = []
    const iconSize = 28
    points.forEach((point, idx) => {
      if (idx % iconInterval !== 0 && idx !== points.length - 1) return
      const category = this.getWeatherSymbolCategory(point.symbolCode)
      const iconSvg = this.buildWeatherIconSvg(category, iconSize)
      const x = getX(idx) - iconSize / 2
      const y = iconRowY - iconSize / 2
      iconElements.push(`<g class="weather-icon" transform="translate(${x.toFixed(2)}, ${y.toFixed(2)})">${iconSvg}</g>`)
    })

    const precipAxisLine = `<line x1="${(width - marginRight).toFixed(2)}" y1="${weatherTop.toFixed(2)}" x2="${(width - marginRight).toFixed(2)}" y2="${weatherBottom.toFixed(2)}" stroke="${config?.gridLineColor ?? '#c3d0d8'}" stroke-width="1" />`
    const weatherBaseline = `<line x1="${marginLeft.toFixed(2)}" y1="${weatherBottom.toFixed(2)}" x2="${(width - marginRight).toFixed(2)}" y2="${weatherBottom.toFixed(2)}" stroke="${config?.gridLineColor ?? '#c3d0d8'}" stroke-width="1" />`
    const windBaseline = `<line x1="${marginLeft.toFixed(2)}" y1="${windAreaBottom.toFixed(2)}" x2="${(width - marginRight).toFixed(2)}" y2="${windAreaBottom.toFixed(2)}" stroke="${config?.gridLineColor ?? '#c3d0d8'}" stroke-width="1" />`

    const windDirectionArrows: string[] = []
    const arrowInterval = Math.max(1, Math.round(points.length / 20))
    points.forEach((point, idx) => {
      if (idx % arrowInterval !== 0 && idx !== points.length - 1) return
      if (typeof point.windDirection !== 'number') return
      const x = getX(idx)
      const rotation = point.windDirection
      windDirectionArrows.push(`<g class="wind-arrow" transform="translate(${x.toFixed(2)}, ${arrowRowY.toFixed(2)}) rotate(${rotation.toFixed(2)})"><path d="M0,-12 L5,6 L0,2 L-5,6 Z" fill="${config?.secondaryTextColor ?? '#56616c'}" /></g>`)
    })

    const legendGroup = `
      <g class="legend" transform="translate(${marginLeft.toFixed(2)}, ${legendY.toFixed(2)})">
        <g>
          <line x1="0" y1="0" x2="26" y2="0" stroke="${temperatureColor}" stroke-width="2.4" stroke-linecap="round" />
          <text class="legend-label" x="34" y="4">Temperature</text>
        </g>
        <g transform="translate(0, 20)">
          <rect x="0" y="-10" width="26" height="10" fill="${precipColor}" />
          <text class="legend-label" x="34" y="-2">Precipitation</text>
        </g>
        <g transform="translate(0, 38)">
          <rect x="0" y="-10" width="26" height="10" fill="url(#max-precipitation-pattern)" stroke="${precipMaxColor}" stroke-width="0.6" />
          <text class="legend-label" x="34" y="-2">Max precipitation</text>
        </g>
        <g transform="translate(180, 0)">
          <line x1="0" y1="0" x2="26" y2="0" stroke="${windColor}" stroke-width="2" stroke-linecap="round" />
          <text class="legend-label" x="34" y="4">Wind speed</text>
        </g>
        <g transform="translate(180, 20)">
          <line x1="0" y1="0" x2="26" y2="0" stroke="${windGustColor}" stroke-width="2" stroke-dasharray="4 4" stroke-linecap="round" />
          <text class="legend-label" x="34" y="4">Wind gust</text>
        </g>
      </g>
    `

    const coords = Array.isArray(forecastJson?.geometry?.coordinates) ? forecastJson.geometry.coordinates : null
    const lon = typeof coords?.[0] === 'number' ? coords[0] : null
    const lat = typeof coords?.[1] === 'number' ? coords[1] : null
    const latLabel = this.formatCoordinateForLabel(lat)
    const lonLabel = this.formatCoordinateForLabel(lon)
    const locationTitle = latLabel && lonLabel ? `Weather forecast for ${latLabel}, ${lonLabel}` : 'Weather forecast'

    const precipAxisTitle = `<text class="axis-title" x="${(width - marginRight + 18).toFixed(2)}" y="${(weatherTop - 16).toFixed(2)}" text-anchor="start" dominant-baseline="middle">mm</text>`
    const windAxisTitle = `<text class="axis-title" x="${(marginLeft - 16).toFixed(2)}" y="${(windAreaBottom + 20).toFixed(2)}" text-anchor="end" dominant-baseline="middle">m/s</text>`
    const titleElement = `<text class="title-label" x="${(width / 2).toFixed(2)}" y="${titleY.toFixed(2)}" text-anchor="middle">${this.escapeXml(locationTitle)}</text>`

    const styleBlock = `
<style>
  text {
    font-family: NRK Sans Variable, -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif;
  }
  .day-label {
    font-size: 1.0666666667rem;
    font-weight: 600;
    line-height: 1.4666666667rem;
    fill: ${config?.mainTextColor ?? '#21292b'};
  }
  .hour-label,
  .y-axis-label,
  .legend-label,
  .axis-title {
    font-size: 0.8666666667rem;
    font-weight: 440;
    line-height: 1.2rem;
    fill: ${config?.secondaryTextColor ?? '#56616c'};
  }
  .title-label {
    font-size: 1.0666666667rem;
    font-weight: 600;
    line-height: 1.4666666667rem;
    fill: ${config?.mainTextColor ?? '#21292b'};
  }
  .precipitation-values-over-max {
    font-size: 0.8rem;
    font-weight: 600;
    line-height: 1rem;
    fill: #ffffff;
  }
</style>
`

    const defs = `
      <defs>
        <pattern id="max-precipitation-pattern" patternUnits="userSpaceOnUse" width="4" height="4">
          <rect x="0" y="0" width="4" height="4" fill="${precipMaxColor}" opacity="0.3" />
          <line x1="0" y1="0" x2="4" y2="4" stroke="${precipMaxColor}" stroke-width="0.5" opacity="0.6" />
          <line x1="4" y1="0" x2="0" y2="4" stroke="${precipMaxColor}" stroke-width="0.5" opacity="0.6" />
        </pattern>
      </defs>
    `

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Yr Weather Forecast">
  ${styleBlock}
  <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" />
  ${defs}
  <g>
    ${dayBoundaryLines.join('')}
    ${horizontalLines.join('')}
    ${windHorizontalLines.join('')}
    ${verticalLines.join('')}
    ${precipAxisLine}
    ${weatherBaseline}
    ${windBaseline}
    ${temperaturePath}
    ${precipitationMaxRects.join('')}
    ${precipitationRects.join('')}
    ${windPath}
    ${windGustPath}
    ${temperatureLabels.join('')}
    ${precipAxisLabels.join('')}
    ${precipAxisTitle}
    ${windAxisLabels.join('')}
    ${windAxisTitle}
    ${hourLabels.join('')}
    ${dayLabels.join('')}
    ${iconElements.join('')}
    ${precipitationLabels.join('')}
    ${windDirectionArrows.join('')}
    ${legendGroup}
    ${titleElement}
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

    .${scope} .svg-image-container svg text {
      fill: ${config.secondaryTextColor} !important;
    }

    .${scope} .svg-image-container svg .day-label,
    .${scope} .svg-image-container svg .title-label {
      fill: ${config.mainTextColor} !important;
    }

    .${scope} .svg-image-container svg .hour-label,
    .${scope} .svg-image-container svg .y-axis-label,
    .${scope} .svg-image-container svg .legend-label,
    .${scope} .svg-image-container svg .axis-title {
      fill: ${config.secondaryTextColor} !important;
    }

    .${scope} .svg-image-container svg .precipitation-values-over-max {
      fill: #ffffff !important;
    }

    .${scope} .svg-image-container svg #max-precipitation-pattern rect {
      fill: ${config.maxPrecipitationColor} !important;
      opacity: 0.3 !important;
    }

    .${scope} .svg-image-container svg #max-precipitation-pattern line {
      stroke: ${config.maxPrecipitationColor} !important;
      opacity: 1 !important;
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
