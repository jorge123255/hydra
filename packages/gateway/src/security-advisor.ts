// Security advisor module - detects security questions and provides specialized analysis
// Routes to security-optimized models and provides structured security responses

import { Intent } from './router.js'
import { OLLAMA_INTENT_MODELS } from './router.js'

// CISSP domains for detection
const CISSP_DOMAINS = [
  'security and risk management',
  'asset security',
  'security architecture and engineering',
  'communication and network security',
  'identity and access management',
  'security assessment and testing',
  'security operations',
  'software development security'
]

// Security keywords and patterns
const SECURITY_PATTERNS = [
  /\b(CISSP|certified information systems security professional)\b/i,
  /\b(vulnerability|exploit|CVE|zero-day|threat|risk|attack|breach|hack)\b/i,
  /\b(encryption|AES|RSA|TLS|SSL|PKI|certificate|hash|HMAC|symmetric|asymmetric)\b/i,
  /\b(firewall|IDS|IPS|SIEM|WAF|DLP|endpoint protection)\b/i,
  /\b(authentication|authorization|MFA|2FA|OAuth|SAML|LDAP|RBAC|ABAC)\b/i,
  /\b(penetration test|pen test|vulnerability scan|red team|blue team)\b/i,
  /\b(compliance|GDPR|HIPAA|PCI DSS|NIST|ISO 27001|FISMA)\b/i,
  /\b(incident response|forensics|malware|phishing|social engineering)\b/i,
  /\b(secure coding|OWASP|SANS|buffer overflow|SQL injection|XSS|CSRF)\b/i,
  /\b(security policy|security control|security framework|security governance)\b/i
]

// Security-focused Ollama models
export const SECURITY_MODELS = {
  primary: 'devstral-2:123b',  // Good for code security analysis
  research: 'nemotron-3-super', // Good for security concepts and frameworks
  deep: 'deepseek-v3.2'         // Good for complex security reasoning
}

/**
 * Detect if a message is security-related
 */
export function isSecurityQuestion(text: string): boolean {
  const lowerText = text.toLowerCase()

  // Check for CISSP domain mentions
  if (CISSP_DOMAINS.some(domain => lowerText.includes(domain))) {
    return true
  }

  // Check security patterns
  if (SECURITY_PATTERNS.some(pattern => pattern.test(text))) {
    return true
  }

  return false
}

/**
 * Get the best model for a security question
 */
export function getSecurityModel(question: string): string {
  const lowerQ = question.toLowerCase()

  // Deep reasoning for complex security scenarios
  if (/\b(analyze|assess|evaluate|compare|trade-off|pro and con)\b/i.test(question) ||
      lowerQ.includes('best approach') || lowerQ.includes('recommend')) {
    return SECURITY_MODELS.deep
  }

  // Research model for conceptual questions
  if (/\b(explain|describe|what is|what are|overview|summary|define)\b/i.test(question) ||
      CISSP_DOMAINS.some(domain => lowerQ.includes(domain))) {
    return SECURITY_MODELS.research
  }

  // Default to primary model (good for technical security questions)
  return SECURITY_MODELS.primary
}

/**
 * Build security-specific system prompt context
 */
export function buildSecurityPromptContext(): string {
  return `
## Security Advisor Mode
You are now operating in Security Advisor mode. Provide expert-level security analysis.

### Guidelines:
- Be precise and technical in security terminology
- Reference relevant frameworks (NIST, ISO 27001, OWASP, etc.)
- For CISSP-related questions, structure answers by domain when appropriate
- Provide actionable recommendations, not just theory
- When discussing vulnerabilities, include mitigation strategies
- Use the MITRE ATT&CK framework for threat analysis when relevant

### Response Format:
For analysis questions, use:
1. **Threat/Vulnerability**: [Description]
2. **Impact**: [Potential consequences]
3. **Likelihood**: [Low/Medium/High]
4. **Mitigation**: [Specific controls or countermeasures]
5. **References**: [Standards, frameworks, or best practices]

For conceptual questions, provide clear definitions with practical examples.
`.trim()
}

