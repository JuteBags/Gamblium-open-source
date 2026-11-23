//! Devanagari to everyday Hinglish ("tera naam", not "terā nāma"): letters by rule, the silent
//! inherent "a" dropped at word ends and between syllables, common words as people spell them.

pub fn is_devanagari(s: &str) -> bool {
    let (mut deva, mut letters) = (0, 0);
    for c in s.chars() {
        if c.is_alphabetic() {
            letters += 1;
            if ('\u{0900}'..='\u{097F}').contains(&c) {
                deva += 1;
            }
        }
    }
    letters > 0 && deva * 2 >= letters
}

fn consonant(c: char) -> Option<&'static str> {
    Some(match c {
        'क' => "k", 'ख' => "kh", 'ग' => "g", 'घ' => "gh", 'ङ' => "n",
        'च' => "ch", 'छ' => "chh", 'ज' => "j", 'झ' => "jh", 'ञ' => "n",
        'ट' => "t", 'ठ' => "th", 'ड' => "d", 'ढ' => "dh", 'ण' => "n",
        'त' => "t", 'थ' => "th", 'द' => "d", 'ध' => "dh", 'न' => "n",
        'प' => "p", 'फ' => "ph", 'ब' => "b", 'भ' => "bh", 'म' => "m",
        'य' => "y", 'र' => "r", 'ल' => "l", 'व' => "v", 'श' => "sh",
        'ष' => "sh", 'स' => "s", 'ह' => "h", 'ळ' => "l",
        '\u{0958}' => "q", '\u{0959}' => "kh", '\u{095A}' => "gh", '\u{095B}' => "z", '\u{095C}' => "d", '\u{095D}' => "rh", '\u{095E}' => "f", '\u{095F}' => "y",
        _ => return None,
    })
}

fn with_nukta(c: char) -> Option<&'static str> {
    Some(match c {
        'क' => "q", 'ख' => "kh", 'ग' => "gh", 'ज' => "z", 'ड' => "d", 'ढ' => "rh", 'फ' => "f", 'य' => "y",
        _ => return None,
    })
}

fn vowel(c: char) -> Option<&'static str> {
    Some(match c {
        'अ' => "a", 'आ' => "aa", 'इ' => "i", 'ई' => "ee", 'उ' => "u", 'ऊ' => "oo", 'ऋ' => "ri",
        'ए' => "e", 'ऐ' => "ai", 'ओ' => "o", 'औ' => "au", 'ऑ' => "o", 'ऍ' => "e",
        _ => return None,
    })
}

fn sign(c: char) -> Option<&'static str> {
    Some(match c {
        'ा' => "aa", 'ि' => "i", 'ी' => "ee", 'ु' => "u", 'ू' => "oo", 'ृ' => "ri",
        'े' => "e", 'ै' => "ai", 'ो' => "o", 'ौ' => "au", 'ॉ' => "o", 'ॅ' => "e",
        _ => return None,
    })
}

const VIRAMA: char = '्';
const NUKTA: char = '़';

/// Words people spell one way whatever the letters say.
fn common(word: &str) -> Option<&'static str> {
    Some(match word {
        "है" => "hai", "हैं" => "hain", "में" => "mein", "मैं" => "main", "यह" => "yeh", "वह" => "woh",
        "नहीं" => "nahi", "नही" => "nahi", "क्या" => "kya", "प्यार" => "pyaar", "दिल" => "dil", "तू" => "tu",
        "तेरा" => "tera", "तेरी" => "teri", "तेरे" => "tere", "मेरा" => "mera", "मेरी" => "meri", "मेरे" => "mere",
        "कि" => "ki", "की" => "ki", "जो" => "jo", "तो" => "toh", "हो" => "ho", "था" => "tha", "थी" => "thi",
        "ये" => "ye", "वो" => "woh", "मुझे" => "mujhe", "तुझे" => "tujhe", "हम" => "hum", "तुम" => "tum",
        "और" => "aur", "भी" => "bhi", "ही" => "hi", "सा" => "sa", "से" => "se", "के" => "ke", "का" => "ka",
        "को" => "ko", "पर" => "par", "जब" => "jab", "तब" => "tab", "अब" => "ab", "सब" => "sab", "कब" => "kab",
        "रहा" => "raha", "रही" => "rahi", "रहे" => "rahe", "कहाँ" => "kahaan", "यहाँ" => "yahaan", "वहाँ" => "wahaan",
        _ => return None,
    })
}

#[derive(Debug)]
struct Syl {
    cons: String,      // consonant cluster ("pr", "k", or "" for a bare vowel)
    vowel: String,     // written vowel, or "a" for the inherent one
    inherent: bool,    // the vowel is the unwritten "a"
    nasal: &'static str,
}

fn word(w: &str) -> String {
    if let Some(c) = common(w) {
        return c.to_owned();
    }
    let chars: Vec<char> = w.chars().collect();
    let mut syls: Vec<Syl> = Vec::new();
    let mut i = 0;
    let mut out_extra = String::new();
    while i < chars.len() {
        let c = chars[i];
        if let Some(v) = vowel(c) {
            syls.push(Syl { cons: String::new(), vowel: v.into(), inherent: false, nasal: "" });
            i += 1;
        } else if consonant(c).is_some() {
            // A cluster: consonant (+ nukta) (+ virama consonant ...)
            let mut cons = String::new();
            loop {
                let base = chars[i];
                let mut roman = consonant(base).unwrap_or("");
                i += 1;
                if i < chars.len() && chars[i] == NUKTA {
                    roman = with_nukta(base).unwrap_or(roman);
                    i += 1;
                }
                cons.push_str(roman);
                if i + 1 < chars.len() && chars[i] == VIRAMA && consonant(chars[i + 1]).is_some() {
                    i += 1;
                    continue;
                }
                break;
            }
            if i < chars.len() && chars[i] == VIRAMA {
                i += 1;
                syls.push(Syl { cons, vowel: String::new(), inherent: false, nasal: "" });
            } else if i < chars.len() && sign(chars[i]).is_some() {
                syls.push(Syl { cons, vowel: sign(chars[i]).unwrap().into(), inherent: false, nasal: "" });
                i += 1;
            } else {
                syls.push(Syl { cons, vowel: "a".into(), inherent: true, nasal: "" });
            }
        } else if c == 'ं' || c == 'ँ' {
            if let Some(last) = syls.last_mut() {
                last.nasal = "n";
            }
            i += 1;
        } else if c == 'ः' {
            if let Some(last) = syls.last_mut() {
                last.nasal = "h";
            }
            i += 1;
        } else {
            out_extra.push(c);
            i += 1;
        }
    }
    // The silent inherent "a": at the end of a word of more than one syllable, and in the middle
    // between a sounded syllable and one with a written vowel ("kal-ya-nee" stays, "sam-jha" -> "samjha").
    let n = syls.len();
    if n > 1 && syls[n - 1].inherent && syls[n - 1].nasal.is_empty() {
        syls[n - 1].vowel.clear();
    }
    for k in 1..n.saturating_sub(1) {
        if syls[k].inherent && syls[k].nasal.is_empty() && !syls[k - 1].vowel.is_empty() && !syls[k + 1].cons.is_empty() && !syls[k + 1].vowel.is_empty() {
            syls[k].vowel.clear();
        }
    }
    let mut s: String = syls.iter().map(|x| format!("{}{}{}", x.cons, x.vowel, x.nasal)).collect();
    // As people type it: a long vowel at the very end is written short ("teraa" -> "tera").
    for (long, short) in [("aa", "a"), ("ee", "i"), ("oo", "u")] {
        if s.len() > long.len() + 1 && s.ends_with(long) {
            s.truncate(s.len() - long.len());
            s.push_str(short);
        }
    }
    s + &out_extra
}

/// A whole line: words converted, everything else (spaces, punctuation, Latin) kept.
pub fn line(text: &str) -> String {
    let mut out = String::new();
    let mut cur = String::new();
    for c in text.chars() {
        let deva = ('\u{0900}'..='\u{097F}').contains(&c) && c != '।' && c != '॥';
        if deva {
            cur.push(c);
        } else {
            if !cur.is_empty() {
                out.push_str(&word(&cur));
                cur.clear();
            }
            out.push(match c { '।' | '॥' => '.', x => x });
        }
    }
    if !cur.is_empty() {
        out.push_str(&word(&cur));
    }
    // Capital at the start of the line, as lyrics are written.
    let mut chars = out.chars();
    match chars.next() {
        Some(f) => f.to_uppercase().collect::<String>() + chars.as_str(),
        None => out,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn everyday_spelling() {
        assert_eq!(line("तुम ही हो"), "Tum hi ho");
        assert_eq!(line("मेरा नाम"), "Mera naam");
        assert_eq!(line("दिल है"), "Dil hai");
        assert_eq!(line("समझा"), "Samjha");
        assert_eq!(line("कल"), "Kal");
        assert_eq!(line("प्यार में"), "Pyaar mein");
        assert_eq!(line("चाँद"), "Chaand");
        // A real caption line (Zaalima, YouTube's Hindi captions).
        assert_eq!(line("जो तेरी खातिर तड़पे पहले से ही क्या उसे तड़पाना ओ जालिमा"), "Jo teri khaatir tadpe pahle se hi kya use tadpaana o jaalima");
        assert!(is_devanagari("तुम ही हो"));
        assert!(!is_devanagari("Tum hi ho"));
    }
}
