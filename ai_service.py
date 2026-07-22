import json
import re
import logging
import os
import requests
import google.generativeai as genai
from groq import Groq
from config import settings

logger = logging.getLogger(__name__)

def generate_ai_completion(prompt: str, system_prompt: str = "You are StockSage AI Copilot.", json_mode: bool = False, user_keys: dict = None):
    user_keys = user_keys or {}
    
    # 1. Try OpenRouter Free (Primary)
    openrouter_key = user_keys.get("OPENROUTER_API_KEY") or settings.OPENROUTER_API_KEY
    if openrouter_key:
        try:
            res = requests.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={"Authorization": f"Bearer {openrouter_key}"},
                json={
                    "model": "meta-llama/llama-3.1-8b-instruct:free",
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": prompt}
                    ],
                    "response_format": {"type": "json_object"} if json_mode else None
                },
                timeout=8
            )
            res.raise_for_status()
            return res.json()['choices'][0]['message']['content']
        except Exception as e:
            logger.warning(f"OpenRouter failed: {e}")
            
    # 2. Try Groq (Fallback 1)
    groq_key = user_keys.get("GROQ_API_KEY") or settings.GROQ_API_KEY
    if groq_key:
        try:
            client = Groq(api_key=groq_key)
            res = client.chat.completions.create(
                model="llama-3.1-8b-instant",
                messages=[{"role": "system", "content": system_prompt}, {"role": "user", "content": prompt}],
                temperature=0.2,
                response_format={"type": "json_object"} if json_mode else None
            )
            return res.choices[0].message.content
        except Exception as e:
            logger.warning(f"Groq failed/rate-limited: {e}")

    # 3. Try Google Gemini Flash (Fallback 2)
    gemini_key = user_keys.get("GEMINI_API_KEY") or settings.GEMINI_API_KEY
    if gemini_key:
        try:
            genai.configure(api_key=gemini_key)
            model_kwargs = {}
            if json_mode:
                model_kwargs["generation_config"] = {"response_mime_type": "application/json"}
            model = genai.GenerativeModel('gemini-1.5-flash', **model_kwargs)
            res = model.generate_content(f"{system_prompt}\n\n{prompt}")
            return res.text
        except Exception as e:
            logger.warning(f"Gemini failed/rate-limited: {e}")

    # Return None if no provider succeeded or no keys are configured
    logger.error("All AI providers failed or no API keys configured.")
    return None

def summarize_news(articles: list[dict], user_keys: dict = None) -> dict:
    """
    Summarize a list of news articles and extract sentiment and takeaways.
    Returns: {"summary": [str, str, str], "sentiment": "Bullish/Bearish/Neutral", "takeaways": [str, str]}
    """
    if not articles:
        return {
            "summary": ["No recent news available to summarize."],
            "sentiment": "Neutral",
            "takeaways": ["No Data"],
        }

    try:
        # Prepare context
        context = ""
        for i, article in enumerate(articles[:10]):
            context += f"Headline {i + 1}: {article.get('title', '')}\n"
            context += f"Snippet {i + 1}: {article.get('description', '')}\n\n"

        system_prompt = """
        You are a seasoned financial analyst. I will provide you with recent news headlines and snippets.
        Analyze them and provide an executive briefing.
        
        Respond ONLY with a valid JSON object matching this schema:
        {
            "summary": ["bullet point 1", "bullet point 2", "bullet point 3"],
            "sentiment": "Bullish" | "Bearish" | "Neutral",
            "takeaways": ["key theme 1", "key theme 2"]
        }
        """

        user_prompt = f"News Data:\n{context}"

        response_text = generate_ai_completion(
            prompt=user_prompt,
            system_prompt=system_prompt,
            json_mode=True,
            user_keys=user_keys
        )

        if not response_text:
            raise Exception("No AI provider was able to generate a response (Check API keys).")

        return json.loads(response_text)
    except Exception as e:
        logger.error(f"Error in news summary: {e}")
        return {
            "summary": [
                "Error generating AI summary.",
                str(e),
                "Please check your API keys and quotas.",
            ],
            "sentiment": "Neutral",
            "takeaways": ["AI Error"],
        }

def ask_copilot(ticker: str, query: str, context: dict, user_keys: dict = None) -> str:
    """
    Answer a user's question about a specific stock using AI.
    """
    try:
        sys_prompt = f"""
        You are an expert AI Stock Analyst Copilot for StockSage.
        You are answering a user query about {ticker}.
        Use the provided context to ground your answer in reality.
        Be concise, analytical, and professional. 
        Format your response in Markdown (bolding key terms, using bullet points if helpful).
        """

        user_prompt = f"""
        User Query: {query}
        
        Stock Context ({ticker}):
        {json.dumps(context, indent=2)}
        """

        response_text = generate_ai_completion(
            prompt=user_prompt,
            system_prompt=sys_prompt,
            json_mode=False,
            user_keys=user_keys
        )
        
        if not response_text:
            return "⚠️ AI Copilot is currently disabled. Please configure your API keys in the settings."
            
        return response_text
    except Exception as e:
        logger.error(f"Error calling Copilot chat: {e}")
        return f"⚠️ An error occurred while generating the response: {e}"

def generate_swot(data: dict, user_keys: dict = None) -> dict:
    # Safely sanitize inputs to prevent JSON prompt injection
    try:
        headlines = data.get('recent_headlines')
        if not headlines or headlines == "None":
            headlines = "No recent headlines available."
    except Exception:
        headlines = "No recent headlines available."
        
    prompt = f"""
    You are a fast API returning a SWOT analysis for {data.get('symbol')}. Be extremely concise (1 short sentence max per bullet) to minimize generation latency.
    
    Data:
    Symbol: {data.get('symbol')}
    Price: {data.get('price')}
    PE: {data.get('pe_ratio')}
    ROIC: {data.get('roic')}
    RevGrowth: {data.get('revenue_growth')}
    Debt/Eq: {data.get('debt_to_equity')}
    Headlines: {headlines}
    
    Provide EXACTLY 2 very short bullet points for each quadrant.
    
    Output JSON format ONLY:
    {{
      "strengths": ["...", "..."],
      "weaknesses": ["...", "..."],
      "opportunities": ["...", "..."],
      "threats": ["...", "..."]
    }}
    """
    
    try:
        response_text = generate_ai_completion(
            prompt=prompt,
            system_prompt="You are a financial analyst providing a SWOT analysis.",
            json_mode=True,
            user_keys=user_keys
        )
        
        if not response_text:
            raise Exception("No AI provider was able to generate a response (Check API keys).")

        # Extract valid JSON from AI text response
        json_match = re.search(r'\{.*\}', response_text, re.DOTALL)
        if json_match:
            swot_data = json.loads(json_match.group(0))
            return swot_data
            
        return json.loads(response_text)
    except Exception as e:
        logger.error(f"Error generating SWOT: {e}")
        return {
            "strengths": ["Error fetching SWOT insights"],
            "weaknesses": [str(e)],
            "opportunities": ["Verify API keys and quotas"],
            "threats": ["AI generation failed"]
        }
