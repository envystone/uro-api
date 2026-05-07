export const config = { runtime: 'edge', regions: ['iad1'] }; // 미국 동부 고정

export default async function handler(request) {
  const CORS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS });
  }

  try {
    const body = await request.json();
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

    if (!GEMINI_API_KEY) {
      return new Response(JSON.stringify({ error: 'API key not configured' }), { status: 500, headers: CORS });
    }

    // ── PubMed 검색 ─────────────────────────────────────────
    if (body.action === 'pubmed_fetch') {
      const desc = body.desc || '';
      const topJournals = [
        "European Urology", "Journal of Urology", "NEJM",
        "New England Journal of Medicine", "Lancet Oncology", "JAMA",
        "Journal of Clinical Oncology", "BJU International",
        "European Urology Oncology", "Nature Medicine",
        "Annals of Oncology", "Cancer", "Urology", "World Journal of Urology"
      ].map(j => `"${j}"[journal]`).join(" OR ");

      // 1차 시도: 고IF 저널 필터 + 2023년 이후
      let searchTerm = encodeURIComponent(`(${desc}) AND ("journal article"[pt]) AND ("2023/01/01"[dp] : "3000"[dp]) AND (${topJournals})`);
      let searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${searchTerm}&retmax=10&sort=date&retmode=json&tool=urodigest&email=urodigest@example.com`;

      let searchRes = await fetch(searchUrl);
      let searchData = await searchRes.json();
      let ids = searchData?.esearchresult?.idlist || [];

      // 2차 시도: 저널 필터 없이 2023년 이후
      if (ids.length === 0) {
        searchTerm = encodeURIComponent(`(${desc}) AND ("journal article"[pt]) AND ("2023/01/01"[dp] : "3000"[dp])`);
        searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${searchTerm}&retmax=10&sort=date&retmode=json&tool=urodigest&email=urodigest@example.com`;
        searchRes = await fetch(searchUrl);
        searchData = await searchRes.json();
        ids = searchData?.esearchresult?.idlist || [];
      }

      // 3차 시도: 저널 필터 없이 기간 제한도 없이
      if (ids.length === 0) {
        searchTerm = encodeURIComponent(`(${desc}) AND ("journal article"[pt])`);
        searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${searchTerm}&retmax=10&sort=date&retmode=json&tool=urodigest&email=urodigest@example.com`;
        searchRes = await fetch(searchUrl);
        searchData = await searchRes.json();
        ids = searchData?.esearchresult?.idlist || [];
      }

      if (ids.length === 0) {
        return new Response(JSON.stringify({ error: '검색 결과가 없습니다. 키워드를 변경해보세요.' }), { status: 404, headers: CORS });
      }

      const fetchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${ids.join(',')}&retmode=xml&tool=urodigest&email=urodigest@example.com`;
      const fetchRes = await fetch(fetchUrl);
      const xmlText = await fetchRes.text();

      const papers = [];
      const articleMatches = xmlText.match(/<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g) || [];

      for (const art of articleMatches.slice(0, 10)) {
        const pmid    = (art.match(/<PMID[^>]*>(\d+)<\/PMID>/) || [])[1] || '';
        const title   = (art.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/) || [])[1]?.replace(/<[^>]+>/g,'').trim() || '';
        const journal = (art.match(/<Title>([\s\S]*?)<\/Title>/) || [])[1]?.replace(/<[^>]+>/g,'').trim() || '';
        const year    = (art.match(/<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>/) || [])[1] || '';
        // 모든 AbstractText 섹션 합치기 (Background/Methods/Results/Conclusions 등)
        const abstMatches = art.match(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g) || [];
        const abst = abstMatches.map(a => a.replace(/<[^>]+>/g,'').trim()).filter(Boolean).join(' ');
        const authorMatches = art.match(/<LastName>([\s\S]*?)<\/LastName>/g) || [];
        const authors = authorMatches.slice(0,3).map(a => a.replace(/<[^>]+>/g,'')).join(', ');
        const authorsStr = authorMatches.length > 1 ? authors + ' et al.' : authors;

        if (pmid && title) papers.push({ pmid, title, journal, year, authors: authorsStr, abstract: abst });
      }

      if (papers.length === 0) {
        return new Response(JSON.stringify({ error: '논문 정보를 가져오지 못했습니다.' }), { status: 500, headers: CORS });
      }

      return new Response(JSON.stringify({ papers }), { status: 200, headers: CORS });
    }

    // ── Gemini 요약 ──────────────────────────────────────────
    if (body.action === 'summarize') {
      const paper = body.paper;
      const prompt = `당신은 비뇨의학과 전문의를 위한 논문 요약 전문가입니다.
아래는 실제 PubMed 논문 정보입니다. 이 내용을 바탕으로 임상 중심의 한국어 요약을 작성하세요.

논문 정보:
- 제목: ${paper.title}
- 저자: ${paper.authors}
- 저널: ${paper.journal} (${paper.year})
- 초록: ${paper.abstract || '초록 없음'}

반드시 중괄호로 시작하는 순수 JSON만 응답하세요. 마크다운 코드블록 절대 금지:

{
  "title_ko": "한국어 제목",
  "quartile": "이 저널의 SCImago Q분위. Q1/Q2/Q3/Q4 중 하나만. 참고: European Urology=Q1, Journal of Urology=Q1, BJU International=Q1, Lancet Oncology=Q1, JAMA=Q1, NEJM=Q1, Journal of Clinical Oncology=Q1, Nature Medicine=Q1, Annals of Oncology=Q1, World Journal of Urology=Q1, Cancer=Q1, Urology=Q2. 모르면 null",
  "study_type": "연구 디자인 (초록 기반으로 추정)",
  "evidence_level": "high 또는 moderate 또는 low",
  "background": "연구 배경 2-3문장(한국어). 왜 이 연구가 필요했는지.",
  "methods": "연구 방법 2-3문장(한국어). 대상, 중재, 평가변수.",
  "key_findings": [
    "핵심 결과 1 (가능하면 수치 포함)",
    "핵심 결과 2",
    "핵심 결과 3"
  ],
  "clinical_pearl": "실제 임상에서 어떻게 적용할지 1-2문장(한국어). 구체적 처방·수술 결정 수준.",
  "limitation": "주요 한계점 1문장(한국어)",
  "whats_next": "향후 연구 방향 1문장(한국어)"
}`;

      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 3000 }
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        return new Response(JSON.stringify({ error: data.error?.message || 'Gemini error' }), { status: res.status, headers: CORS });
      }

      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return new Response(JSON.stringify({ text }), { status: 200, headers: CORS });
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers: CORS });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
  }
}
