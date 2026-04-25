const minimist = require('minimist');
const _ = require('lodash');

class generalHelper {

    collectArguments() {
        return minimist(process.argv.slice(2));
    }

    replaceVariables(content, query = {}) {
        return content.replace(/\$\{([^}]+)\}/g, (match, expr) => {
            expr = expr.trim();
            if (expr.startsWith('process.env.')) {
                const key = expr.slice('process.env.'.length);
                return process.env[key] ?? match;
            }
            if (expr.startsWith('query.')) {
                const path = expr.slice('query.'.length);
                const val  = _.get(query, path);
                return (val !== undefined && val !== null) ? String(val) : match;
            }
            return match;
        });
    }

    stateNames() {
        return {
            'AL': 'Alabama',
            'AK': 'Alaska',
            'AZ': 'Arizona',
            'AR': 'Arkansas',
            'CA': 'California',
            'CO': 'Colorado',
            'CT': 'Connecticut',
            'DE': 'Delaware',
            'FL': 'Florida',
            'GA': 'Georgia',
            'HI': 'Hawaii',
            'ID': 'Idaho',
            'IL': 'Illinois',
            'IN': 'Indiana',
            'IA': 'Iowa',
            'KS': 'Kansas',
            'KY': 'Kentucky',
            'LA': 'Louisiana',
            'ME': 'Maine',
            'MD': 'Maryland',
            'MA': 'Massachusetts',
            'MI': 'Michigan',
            'MN': 'Minnesota',
            'MS': 'Mississippi',
            'MO': 'Missouri',
            'MT': 'Montana',
            'NE': 'Nebraska',
            'NV': 'Nevada',
            'NH': 'New Hampshire',
            'NJ': 'New Jersey',
            'NM': 'New Mexico',
            'NY': 'New York',
            'NC': 'North Carolina',
            'ND': 'North Dakota',
            'OH': 'Ohio',
            'OK': 'Oklahoma',
            'OR': 'Oregon',
            'PA': 'Pennsylvania',
            'RI': 'Rhode Island',
            'SC': 'South Carolina',
            'SD': 'South Dakota',
            'TN': 'Tennessee',
            'TX': 'Texas',
            'UT': 'Utah',
            'VT': 'Vermont',
            'VA': 'Virginia',
            'WA': 'Washington',
            'WV': 'West Virginia',
            'WI': 'Wisconsin',
            'WY': 'Wyoming',
        };
    }

    formatCountyName(county = '', state = '') {
        const countyPascal = String(county)
            .trim()
            .toLowerCase()
            .replace(/[^\w\s-]/g, '')
            .split(/[\s_-]+/)
            .filter(Boolean)
            .map(part => part.charAt(0).toUpperCase() + part.slice(1))
            .join('');

        const stateCode = String(state).trim().toUpperCase();
        return `${countyPascal}${stateCode}`;
    }

    businessIndicators() {
        return [
            // Legal entity suffixes
            'LLC', 'INC', 'CORP', 'LTD', 'LP', 'LLP', 'LLP.', 'LLLP',
            'PC', 'P.C.', 'PA', 'P.A.', 'PLLC', 'PLCC',
            'CO.', 'CO', 'COMPANY', 'COMPANIES',
            'INCORPORATED', 'CORPORATION', 'LIMITED',
            // Partnerships & ownership structures
            'PARTNERS', 'PARTNERSHIP', 'JOINT VENTURE', 'JV',
            'GENERAL PARTNER', 'GP', 'VENTURE',
            // Trusts & legal instruments
            'TRUST', 'TRUSTEE', 'TRUSTEES', 'TR', 'TR.',
            'REVOCABLE TRUST', 'IRREVOCABLE TRUST', 'LIVING TRUST',
            'LAND TRUST', 'FAMILY TRUST', 'TESTAMENTARY TRUST',
            'DECLARATION OF TRUST',
            // Associations & organizations
            'ASSOCIATION', 'ASSOC', 'ASSOC.',
            'HOMEOWNERS ASSOCIATION', 'HOA',
            'CONDOMINIUM ASSOCIATION', 'CONDO ASSOC',
            'COOPERATIVE', 'COOP', 'CO-OP',
            'FOUNDATION', 'INSTITUTE', 'ORGANIZATION',
            'SOCIETY', 'UNION', 'COALITION', 'COUNCIL',
            'AUTHORITY', 'AGENCY', 'BUREAU', 'BOARD',
            'DISTRICT', 'MUNICIPALITY', 'COUNTY', 'CITY OF',
            'STATE OF', 'DEPARTMENT OF', 'DEPT OF',
            'CHURCH', 'PARISH', 'DIOCESE', 'MINISTRY',
            'SCHOOL', 'UNIVERSITY', 'COLLEGE', 'ACADEMY',
            'HOSPITAL', 'CLINIC', 'MEDICAL CENTER',
            // Real estate specific
            'PROPERTIES', 'PROPERTY', 'PROP',
            'REALTY', 'REAL ESTATE', 'REALTORS',
            'HOLDINGS', 'HOLDING',
            'ESTATES', 'ESTATE',
            'MANOR', 'MANORS',
            'DEVELOPMENT', 'DEVELOPMENTS', 'DEVELOPERS',
            'LAND', 'LANDS',
            'ACRES', 'ACREAGE',
            'TOWNHOMES', 'TOWNHOUSE',
            'APARTMENTS', 'APTS',
            'RENTALS', 'RENTAL',
            // Finance & investment
            'FUND', 'FUNDS',
            'INVESTMENTS', 'INVESTMENT', 'INVEST',
            'INVESTORS', 'INVESTOR',
            'CAPITAL', 'ASSET', 'ASSETS',
            'EQUITY', 'EQUITIES',
            'FINANCIAL', 'FINANCE',
            'MORTGAGE', 'LENDING', 'CREDIT',
            'BANK', 'BANKING', 'BANCORP', 'BANCSHARES',
            'SECURITIES', 'PORTFOLIO',
            'REIT', 'MANAGEMENT',
            // Business operations
            'ENTERPRISES', 'ENTERPRISE',
            'GROUP', 'GROUPS',
            'SERVICES', 'SERVICE', 'SVC',
            'SOLUTIONS', 'SOLUTION',
            'SYSTEMS', 'SYSTEM',
            'INDUSTRIES', 'INDUSTRY', 'INDUSTRIAL',
            'INTERNATIONAL', 'INTL', 'GLOBAL', 'WORLDWIDE',
            'NATIONAL', 'REGIONAL', 'AMERICAN',
            'NETWORK', 'NETWORKS',
            'RESOURCES', 'RESOURCE',
            'TECHNOLOGIES', 'TECHNOLOGY', 'TECH',
            'CONSULTING', 'CONSULTANTS', 'CONSULTING GROUP',
            'CONSTRUCTION', 'BUILDERS', 'BUILDER',
            'CONTRACTING', 'CONTRACTORS', 'CONTRACTOR',
            'SUPPLY', 'SUPPLIES', 'DISTRIBUTION',
            'MANUFACTURING', 'MFG',
            'MEDIA', 'COMMUNICATIONS', 'BROADCASTING',
            'HEALTH', 'HEALTHCARE', 'WELLNESS',
            'LOGISTICS', 'TRANSPORT', 'TRANSPORTATION',
            // Common abbreviations on deeds
            'STREET', 'AVE', 'ETF',
            'REV TR', 'FAM TR', 'LVG TR',
            'TTEE', 'ETAL', 'ET AL', 'ET UX',
        ];
    }
}

module.exports = generalHelper;