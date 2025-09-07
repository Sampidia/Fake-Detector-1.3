import { AIProviderConfig, AIResponse, AIRequest } from './types-fixed'

export class OpenAIService {
  private apiKey: string
  private baseUrl = 'https://api.openai.com/v1'
  private config: AIProviderConfig

  constructor(config: AIProviderConfig) {
    this.apiKey = config.apiKey
    this.config = config
  }

  async processText(request: AIRequest): Promise<AIResponse> {
    const startTime = Date.now()

    try {
      // Generate prompt based on task type
      const prompt = this.generatePrompt(request.text, request.task)

      // Determine model based on config
      const modelToUse = this.config.modelName === 'gpt-4' ? 'gpt-4' : 'gpt-3.5-turbo'

      // Make API call to OpenAI
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: modelToUse,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: Math.min(request.maxTokens || 2048, this.config.maxTokens),
          temperature: request.temperature || this.config.temperature || 0.7
        })
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(`OpenAI API error: ${error.error?.message || 'Unknown error'}`)
      }

      const result = await response.json()

      const content = result.choices?.[0]?.message?.content
      if (!content) {
        throw new Error('No content in OpenAI response')
      }

      const responseTime = Date.now() - startTime
      const usage = result.usage

      // Extract structured data based on task type
      const extractedData = this.extractStructuredData(content, request.task)

      return {
        content,
        extractedData,
        usage: {
          inputTokens: usage?.prompt_tokens || Math.ceil(request.text.length / 4),
          outputTokens: usage?.completion_tokens || Math.ceil(content.length / 4),
          cost: this.calculateCost(usage?.prompt_tokens || 0, usage?.completion_tokens || 0)
        },
        metadata: {
          model: modelToUse,
          provider: 'openai',
          responseTime,
          success: true,
          finishReason: result.choices?.[0]?.finish_reason || 'completed'
        }
      }

    } catch (error) {
      console.error('OpenAI error:', error)

      return {
        content: '',
        extractedData: null,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cost: 0
        },
        metadata: {
          model: this.config.modelName,
          provider: 'openai',
          responseTime: Date.now() - startTime,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          finishReason: 'error'
        }
      }
    }
  }

  private generatePrompt(text: string, task: string): string {
    const basePrompts = {
      ocr: `
        You are an expert at extracting structured information from OCR text from product packaging.

        OCR TEXT: ${text}

        Extract and structure the following information from this text. Return as valid JSON:

        {
          "productNames": ["name of the product found"],
          "batchNumbers": ["batch numbers found in format ABC123, T456789, etc"],
          "expiryDate": "expiry date in YYYY-MM-DD format if found",
          "manufacturers": ["manufacturer names mentioned"],
          "confidence": 0.9
        }

        Only include information you can confidently extract. Return JSON only.
      `,

      verification: `
        You are a counterfeit detection expert analyzing product information.

        PRODUCT DATA: ${text}

        Determine if this product matches any counterfeit indicators. Return as JSON:

        {
          "isCounterfeit": true/false,
          "confidence": 0.85,
          "reason": "why this product may be counterfeit/recalled/expired",
          "riskLevel": "LOW/MEDIUM/HIGH/CRITICAL",
          "recommendation": "what user should do about this product"
        }

        Be conservative - only flag as counterfeit with strong evidence in the data provided.
        Return valid JSON only.
      `,

      extraction: `
        You are analyzing an alert text from a regulatory authority about counterfeit/unsafe products.

        ALERT TEXT: ${text}

        Extract structured information about affected products:

        {
          "productNames": ["all product names mentioned"],
          "batchNumbers": ["all batch numbers mentioned"],
          "reason": "why this product was recalled/banned/faked",
          "category": "RECALL/COUNTERFEIT/EXPIRED/QUALITY_ISSUE",
          "manufacturer": "manufacture company name",
          "affectedRegions": ["countries/regions affected"],
          "severity": "HIGH/MEDIUM/LOW"
        }

        Focus on accuracy. Return valid JSON only.
      `
    }

    return basePrompts[task as keyof typeof basePrompts] ||
           `Extract key information from this text: ${text}. Return as structured JSON.`
  }

  private extractStructuredData(content: string, task: string) {
    try {
      // Try to parse as JSON first (from structured prompt responses)
      const jsonMatch = content.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        if (parsed && typeof parsed === 'object') {
          return parsed
        }
      }

      // Fallback: extract structured information using regex patterns
      switch (task) {
        case 'ocr':
          return this.extractOCRFromText(content)
        case 'verification':
          return this.extractVerificationFromText(content)
        case 'extraction':
          return this.extractAlertFromText(content)
        default:
          return { rawResponse: content }
      }
    } catch (error) {
      console.warn('Failed to extract structured data:', error)
      return { rawResponse: content }
    }
  }

  private extractOCRFromText(text: string) {
    const result: Record<string, unknown> = {}

    // Extract batch numbers with various patterns
    const batchRegex = /(?:batch|lot)\s*(?:number|no\.?)?\s*:?\s*([A-Z0-9\-\/\.\s]{3,})/gi
    const batches = Array.from(text.matchAll(batchRegex), m =>
      m[1]?.trim().replace(/\s+/g, ' ')
    ).filter(Boolean)

    if (batches.length > 0) result.batchNumbers = batches

    // Extract product names
    const productPatterns = [
      /(?:product|medicine|drug)[s]?[:\s]*([^&\n\r]{5,30})/i,
      /(?:tablet|capsule|injection|syrup)[s]?[:\s]*([^&\n\r]{5,30})/i
    ]

    const productNames: string[] = []
    productPatterns.forEach(pattern => {
      const matches = text.match(pattern)
      if (matches && matches[1]) {
        productNames.push(matches[1].trim())
      }
    })

    if (productNames.length > 0) result.productNames = productNames

    // Extract expiry dates
    const expiryPatterns = [
      /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/g,
      /exp(?:iry)?\s*(?:date)?\s*:?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/gi
    ]

    expiryPatterns.forEach(pattern => {
      const matches = text.match(pattern)
      if (matches && !result.expiryDate) {
        result.expiryDate = matches[0]
      }
    })

    const hasData = Object.keys(result).length > 0
    result.confidence = hasData ? 0.85 : 0.2

    return result
  }

  private extractVerificationFromText(text: string) {
    const result: Record<string, unknown> = {}

    // Analyze text for counterfeit indicators
    const riskIndicators = /(?:fake|counterfeit|falsified|spurious|adulterated|expired)/i
    const trustIndicators = /(?:verified|authenticated|genuine|safe)/i

    const hasRisk = riskIndicators.test(text)
    const hasTrust = trustIndicators.test(text)

    result.isCounterfeit = hasRisk && !hasTrust

    // Determine confidence and risk level
    if (hasRisk && hasTrust) {
      result.confidence = 0.6
      result.riskLevel = 'MEDIUM'
      result.reason = 'Mixed signals - some risk indicators but also signs of authenticity'
      result.recommendation = 'Verify with manufacturer or additional sources'
    } else if (hasRisk) {
      result.confidence = 0.9
      result.riskLevel = 'HIGH'
      result.reason = 'Strong counterfeit/adulterated indicators detected'
      result.recommendation = 'Do not use this product - contact regulatory authorities'
    } else {
      result.confidence = 0.8
      result.riskLevel = 'LOW'
      result.reason = 'No counterfeit indicators detected'
      result.recommendation = 'Product appears safe based on available information'
    }

    return result
  }

  private extractAlertFromText(text: string) {
    const result: Record<string, unknown> = {
      productNames: [],
      batchNumbers: [],
      affectedRegions: []
    }

    // Extract product names
    const productRegex = /(?:product|medicine|drug)[s]?[:\s]*([^\n\r]{5,40})/gi
    const productMatches = Array.from(text.matchAll(productRegex), m => m[1]?.trim())
    ;(result.productNames as string[]).push(...productMatches)

    // Extract batch numbers
    const batchRegex = /(?:batch|lot)\s*(?:number|no\.?)?\s*:?\s*([A-Z0-9\-\/\.]{3,})/gi
    const batchMatches = Array.from(text.matchAll(batchRegex), m => m[1]?.trim())
    ;(result.batchNumbers as string[]).push(...batchMatches)

    // Determine reason and category
    if (/(?:fake|counterfeit|falsified|spurious)/i.test(text)) {
      result.reason = 'Product found to be counterfeit or falsified'
      result.category = 'COUNTERFEIT'
      result.severity = 'HIGH'
    } else if (/(?:recall|withdraw)/i.test(text)) {
      result.reason = 'Product recalled due to safety concerns'
      result.category = 'RECALL'
      result.severity = 'HIGH'
    } else if (/(?:expired|adulterated)/i.test(text)) {
      result.reason = 'Product expired or found to be adulterated'
      result.category = 'EXPIRED'
      result.severity = 'MEDIUM'
    } else {
      result.reason = 'Quality or regulatory concern detected'
      result.category = 'QUALITY_ISSUE'
      result.severity = 'MEDIUM'
    }

    // Extract manufacturer
    const manufacturerRegex = /(?:manufacturer|producer|company)[^\n\r]*([^\n\r]{3,30})/i
    const manufacturerMatch = text.match(manufacturerRegex)
    if (manufacturerMatch) {
      result.manufacturer = manufacturerMatch[1].trim()
    }

    return result
  }

  private calculateCost(promptTokens: number, completionTokens: number): number {
    // OpenAI pricing (as of 2024)
    let inputCost = 0
    let outputCost = 0

    if (this.config.modelName === 'gpt-4') {
      inputCost = (promptTokens / 1000) * 0.03      // $0.03 per 1K input tokens
      outputCost = (completionTokens / 1000) * 0.06 // $0.06 per 1K output tokens
    } else {
      inputCost = (promptTokens / 1000) * 0.002     // $0.0015 per 1K input tokens (GPT-3.5)
      outputCost = (completionTokens / 1000) * 0.002 // $0.002 per 1K output tokens (GPT-3.5)
    }

    return inputCost + outputCost
  }

  async checkHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      })
      return response.ok
    } catch {
      return false
    }
  }

  async getAvailableModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` }
      })

      if (!response.ok) return []

      const result = await response.json()
      return result.data
        ?.filter((model: { id: string }) =>
          model.id.includes('gpt') && !model.id.includes('instruct')
        )
        .map((model: { id: string }) => model.id) || []

    } catch {
      return ['gpt-3.5-turbo', 'gpt-4']
    }
  }
}
