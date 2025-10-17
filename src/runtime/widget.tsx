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

interface ForecastPoint {
  date: Date
  temperature: number | null
  windSpeed: number | null
  windGust: number | null
  precipitation: number
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

    const rawPoints = timeseries
      .slice(0, 48)
      .map(entry => {
        const isoTime = entry?.time
        const date = isoTime ? new Date(isoTime) : null
        const details = entry?.data?.instant?.details ?? {}
        const nextHour = entry?.data?.next_1_hours?.details ?? entry?.data?.next_6_hours?.details ?? entry?.data?.next_12_hours?.details ?? {}

        const temperatureRaw = Number(details?.air_temperature)
        const windSpeedRaw = Number(details?.wind_speed)
        const windGustRaw = Number(details?.wind_speed_of_gust)
        const precipitationRaw = Number(nextHour?.precipitation_amount)

        return {
          date,
          temperature: Number.isFinite(temperatureRaw) ? temperatureRaw : null,
          windSpeed: Number.isFinite(windSpeedRaw) ? windSpeedRaw : null,
          windGust: Number.isFinite(windGustRaw) ? windGustRaw : null,
          precipitation: Number.isFinite(precipitationRaw) ? Math.max(precipitationRaw, 0) : 0
        }
      })
    const points: ForecastPoint[] = rawPoints
      .filter((p): p is ForecastPoint => p.date instanceof Date && !Number.isNaN(p.date.getTime()))

    if (points.length === 0) {
      throw new Error('Unable to parse any valid forecast points from Locationforecast response.')
    }

    const temperatures = points.map(p => p.temperature).filter((v): v is number => Number.isFinite(v))
    const winds = points.map(p => p.windSpeed).filter((v): v is number => Number.isFinite(v))
    const gusts = points.map(p => p.windGust).filter((v): v is number => Number.isFinite(v))
    const precipitationValues = points.map(p => p.precipitation ?? 0)

    const tempMin = temperatures.length ? Math.min(...temperatures) : 0
    const tempMax = temperatures.length ? Math.max(...temperatures) : 0
    const tempRange = tempMax - tempMin || 10

    const windMax = winds.length ? Math.max(...winds) : 0
    const gustMax = gusts.length ? Math.max(...gusts) : 0
    const windRange = Math.max(windMax, gustMax, 5)

    const precipMax = Math.max(...precipitationValues, 1)

    const width = 860
    const paddingLeft = 80
    const paddingRight = 40
    const paddingTop = 40
    const paddingBottom = 140
    const tempChartHeight = 240
    const windChartHeight = 100
    const precipChartHeight = 100
    const sectionGap = 40
    const tempSectionTop = paddingTop
    const tempSectionBottom = tempSectionTop + tempChartHeight
    const windSectionTop = tempSectionBottom + sectionGap
    const windSectionBottom = windSectionTop + windChartHeight
    const precipSectionTop = windSectionBottom + sectionGap
    const precipSectionBottom = precipSectionTop + precipChartHeight
    const chartBottom = precipSectionBottom
    const height = chartBottom + paddingBottom
    const chartWidth = width - paddingLeft - paddingRight

    const step = points.length > 1 ? chartWidth / (points.length - 1) : chartWidth

    const formatHourLabel = (date: Date): string => {
      const hours = date.getHours().toString().padStart(2, '0')
      const day = date.getDate().toString().padStart(2, '0')
      const month = (date.getMonth() + 1).toString().padStart(2, '0')
      return `${day}.${month} ${hours}:00`
    }

    const gridLines: string[] = []
    const gridCount = 6
    for (let i = 0; i <= gridCount; i++) {
      const y = paddingTop + (tempChartHeight / gridCount) * i
      gridLines.push(`<line x1="${paddingLeft}" y1="${y.toFixed(2)}" x2="${(width - paddingRight).toFixed(2)}" y2="${y.toFixed(2)}" stroke="#56616c" stroke-width="1" stroke-opacity="0.4" />`)
    }

    const sectionSeparators = [
      tempSectionTop,
      tempSectionBottom,
      windSectionTop,
      windSectionBottom,
      precipSectionTop,
      precipSectionBottom
    ].map(y => `<line x1="${paddingLeft}" y1="${y.toFixed(2)}" x2="${(width - paddingRight).toFixed(2)}" y2="${y.toFixed(2)}" stroke="#56616c" stroke-width="1" stroke-opacity="0.6" />`)

    const tempPathSegments: string[] = []
    points.forEach((point, idx) => {
      if (!Number.isFinite(point.temperature)) {
        return
      }
      const x = paddingLeft + step * idx
      const y = this.computeChartYPosition(point.temperature, tempMin, tempRange, tempChartHeight, paddingTop)
      tempPathSegments.push(`${tempPathSegments.length === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`)
    })

    const temperaturePath = tempPathSegments.length > 1
      ? `<path d="${tempPathSegments.join(' ')}" fill="none" stroke="#c60000" stroke-width="2" />`
      : ''

    const windPathSegments: string[] = []
    points.forEach((point, idx) => {
      if (!Number.isFinite(point.windSpeed)) {
        return
      }
      const x = paddingLeft + step * idx
      const y = windSectionTop + (windChartHeight - (Math.min(point.windSpeed, windRange) / windRange) * windChartHeight)
      windPathSegments.push(`${windPathSegments.length === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`)
    })

    const gustPathSegments: string[] = []
    points.forEach((point, idx) => {
      if (!Number.isFinite(point.windGust)) {
        return
      }
      const x = paddingLeft + step * idx
      const y = windSectionTop + (windChartHeight - (Math.min(point.windGust, windRange) / windRange) * windChartHeight)
      gustPathSegments.push(`${gustPathSegments.length === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`)
    })

    const windPath = windPathSegments.length > 1
      ? `<path d="${windPathSegments.join(' ')}" fill="none" stroke="#aa00f2" stroke-width="2" />`
      : ''

    const gustPath = gustPathSegments.length > 1
      ? `<path d="${gustPathSegments.join(' ')}" fill="none" stroke="#aa00f2" stroke-width="2" stroke-dasharray="6 4" />`
      : ''

    const precipitationRects: string[] = []
    points.forEach((point, idx) => {
      const value = Math.max(point.precipitation ?? 0, 0)
      if (value <= 0) {
        return
      }
      const xCenter = paddingLeft + step * idx
      const barWidth = Math.min(step * 0.6, 14)
      const x = xCenter - barWidth / 2
      const scaled = Math.min(value / precipMax, 1)
      const heightValue = scaled * precipChartHeight
      const y = precipSectionTop + (precipChartHeight - heightValue)
      precipitationRects.push(`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${heightValue.toFixed(2)}" fill="#006edb" />`)
    })

    const timeLabels: string[] = []
    const labelCount = Math.min(points.length, 16)
    const interval = Math.max(1, Math.floor(points.length / labelCount))
    points.forEach((point, idx) => {
      if (idx % interval !== 0 && idx !== points.length - 1) {
        return
      }
      const x = paddingLeft + step * idx
      const y = chartBottom + 40
      timeLabels.push(`<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" class="hour-label" text-anchor="middle" fill="#56616c" font-size="12">${formatHourLabel(point.date)}</text>`)
    })

    const temperatureLabels: string[] = []
    const tempStep = tempRange / 4
    for (let i = 0; i <= 4; i++) {
      const value = tempMin + tempStep * i
      const y = this.computeChartYPosition(value, tempMin, tempRange, tempChartHeight, paddingTop)
      temperatureLabels.push(`<text x="${(paddingLeft - 10).toFixed(2)}" y="${(y + 4).toFixed(2)}" class="y-axis-label temperature-label" text-anchor="end" fill="#56616c" font-size="12">${value.toFixed(1)}°C</text>`)
    }

    const windLabels: string[] = []
    const windStep = windRange / 4
    for (let i = 0; i <= 4; i++) {
      const value = windStep * i
      const y = windSectionTop + (windChartHeight - (value / windRange) * windChartHeight)
      windLabels.push(`<text x="${(paddingLeft - 10).toFixed(2)}" y="${(y + 4).toFixed(2)}" class="y-axis-label wind-label" text-anchor="end" fill="#56616c" font-size="12">${value.toFixed(1)} m/s</text>`)
    }

    const precipitationLabels: string[] = []
    const precipStep = precipMax / 4
    for (let i = 0; i <= 4; i++) {
      const value = precipStep * i
      const y = precipSectionTop + (precipChartHeight - (value / precipMax) * precipChartHeight)
      precipitationLabels.push(`<text x="${(paddingLeft - 10).toFixed(2)}" y="${(y + 4).toFixed(2)}" class="y-axis-label precipitation-label" text-anchor="end" fill="#56616c" font-size="12">${value.toFixed(1)} mm</text>`)
    }

    const tempPointsMarkers: string[] = []
    points.forEach((point, idx) => {
      if (!Number.isFinite(point.temperature)) return
      const x = paddingLeft + step * idx
      const y = this.computeChartYPosition(point.temperature, tempMin, tempRange, tempChartHeight, paddingTop)
      tempPointsMarkers.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="2" fill="#c60000" />`)
    })

    const sectionLabels = [
      { text: 'Temperature', x: paddingLeft, y: tempSectionTop - 12 },
      { text: 'Wind speed / gust', x: paddingLeft, y: windSectionTop - 12 },
      { text: 'Precipitation', x: paddingLeft, y: precipSectionTop - 12 }
    ].map(({ text, x, y }) => `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" class="legend-label" text-anchor="start" fill="#56616c" font-size="14" font-weight="600">${text}</text>`)

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
  <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" />
  ${defs}
  <g font-family="'Arial', sans-serif">
    <g>
      ${gridLines.join('')}
      ${sectionSeparators.join('')}
      ${temperaturePath}
      ${tempPointsMarkers.join('')}
      ${windPath}
      ${gustPath}
      ${precipitationRects.join('')}
    </g>
    <g>
      ${temperatureLabels.join('')}
      ${windLabels.join('')}
      ${precipitationLabels.join('')}
    </g>
    <g>
      ${timeLabels.join('')}
      ${sectionLabels.join('')}
    </g>
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
