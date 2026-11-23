//! Edit text in place: what stays must stay to the byte and to the point.
use super::textedit::renderer_glyphs;
use super::textedit::testkit::*;
use lopdf::{dictionary, Document, Object, Stream};

fn pdf(fonts: impl FnOnce(&mut Document) -> lopdf::Dictionary, content: &str) -> Vec<u8> {
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let fonts = fonts(&mut doc);
    let c = doc.add_object(Stream::new(dictionary! {}, content.as_bytes().to_vec()));
    let page = doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages_id, "Contents" => c, "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()], "Resources" => dictionary! { "Font" => fonts } });
    doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1 }));
    let cat = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", cat);
    let mut v = vec![];
    doc.save_to(&mut v).unwrap();
    v
}

fn standard(content: &str) -> Vec<u8> {
    pdf(
        |_| dictionary! {
            "F1" => dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica" },
            "F2" => dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica-Bold" },
            "F3" => dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Times-Italic", "Encoding" => "WinAnsiEncoding" },
        },
        content,
    )
}

/// A composite font as printer drivers and Word write it: two-byte codes that are glyph numbers
/// (code = character - 29, as in Arial), a ToUnicode map for the characters used, widths.
fn composite(doc: &mut Document, name: &str, weight: i64, chars: &str) -> Object {
    let mut cmap = String::from("/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange\n");
    let mut w: Vec<Object> = Vec::new();
    cmap.push_str(&format!("{} beginbfchar\n", chars.chars().count()));
    for ch in chars.chars() {
        let code = ch as u32 - 29;
        cmap.push_str(&format!("<{code:04X}> <{:04X}>\n", ch as u32));
        w.push((code as i64).into());
        w.push(Object::Array(vec![(if ch == ' ' { 278 } else { 556 }).into()]));
    }
    cmap.push_str("endbfchar endcmap end end");
    let tu = doc.add_object(Stream::new(dictionary! {}, cmap.into_bytes()));
    let desc = doc.add_object(dictionary! { "Type" => "FontDescriptor", "FontName" => name, "Flags" => 32, "FontWeight" => weight, "ItalicAngle" => 0 });
    let cid = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "CIDFontType2", "BaseFont" => name, "DW" => 1000, "W" => w, "FontDescriptor" => desc });
    doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type0", "BaseFont" => name, "Encoding" => "Identity-H", "ToUnicode" => tu, "DescendantFonts" => vec![Object::Reference(cid)] }).into()
}

fn hex(text: &str) -> String {
    text.chars().map(|c| format!("{:04X}", c as u32 - 29)).collect()
}

type Seen = (u32, f64, f64, String, String);
fn at<'a>(g: &'a [Seen], text: &str, nth: usize) -> &'a Seen {
    g.iter().filter(|x| x.4 == text).nth(nth).unwrap_or_else(|| panic!("no {text} #{nth}"))
}

#[test]
fn a_word_changes_and_the_rest_of_the_string_keeps_its_bytes() {
    let b = standard("BT /F2 26 Tf 56 720 Td (Quarterly Report) Tj ET\nBT /F1 11 Tf 56 680 Td (Line 1 of page 1) Tj ET");
    assert_eq!(lines_of(&b, 0), ["Quarterly Report", "Line 1 of page 1"]);
    // "Report" (items 10..16) becomes "Summary".
    let e = edit(&b, 0, &[0, 10, 16], "Summary").unwrap();
    assert_eq!(lines_of(&e, 0), ["Quarterly Summary", "Line 1 of page 1"]);
    let c = content(&e, 0);
    assert!(c.contains("(Quarterly Summary)"), "{c}");
    assert!(c.contains("/F2 26 Tf"), "the bold title font is the one that shows it: {c}");
    assert!(c.contains("(Line 1 of page 1) Tj"), "the other line is untouched: {c}");
    // Nothing else moved.
    let (g0, g1) = (glyphs_of(&b, 0), glyphs_of(&e, 0));
    for i in 0..10 {
        assert_eq!((g0[i].1, g0[i].2), (g1[i].1, g1[i].2));
    }
    assert_eq!(at(&g0, "L", 0).1, at(&g1, "L", 0).1);
}

#[test]
fn this_module_reads_a_page_as_the_renderer_draws_it() {
    let b = standard(
        "1 0 0 1 10 5 cm q 0.5 0 0 0.5 0 0 cm BT /F2 26 Tf 2 Tc 56 720 Td (Quarterly Report) Tj ET Q\n\
         BT /F1 11 Tf 14 TL 56 680 Td [(Line) -250 ( 1 of) 30 ( page)] TJ T* (next) Tj (more) ' /F3 9 Tf 110 Tz 3 Tw (a b c) Tj ET",
    );
    let ours = glyphs_of(&b, 0);
    let theirs = renderer_glyphs(b.clone(), 0);
    assert_eq!(ours.len(), theirs.len());
    assert!(ours.len() > 40);
    for (o, t) in ours.iter().zip(&theirs) {
        assert_eq!(o.0, t.0);
        assert!((o.1 - t.1).abs() < 0.05 && (o.2 - t.2).abs() < 0.05, "{o:?} against {t:?}");
    }
}

#[test]
fn an_edit_inside_a_line_of_several_fonts_keeps_the_other_runs() {
    // Regular, a bold name, regular again, then a piece placed by itself right after, a far
    // column on the same baseline, and a second line.
    let b = standard(
        "BT /F1 12 Tf 72 700 Td (Dear ) Tj /F2 12 Tf (Sandhya) Tj /F1 12 Tf [(, wel) -20 (come)] TJ ET\n\
         BT /F3 12 Tf 1 0 0 1 204 700 Tm ( back) Tj ET\n\
         BT /F1 12 Tf 1 0 0 1 400 700 Tm (Column) Tj ET\n\
         BT /F1 12 Tf 72 680 Td (Second line) Tj ET",
    );
    let l = lines_of(&b, 0);
    assert_eq!(l, ["Dear Sandhya, welcome back", "Column", "Second line"]);
    // The caret after "Sandhya" (item 12), "yy" typed: it is bold, like the letter before it.
    let e = edit(&b, 0, &[0, 12, 12], "yy").unwrap();
    assert_eq!(lines_of(&e, 0), ["Dear Sandhyayy, welcome back", "Column", "Second line"]);
    let c = content(&e, 0);
    assert!(c.contains("(Dear ) Tj"), "{c}");
    assert!(c.contains("/F2 12 Tf\n[(Sandhyayy)] TJ"), "{c}");
    assert!(c.contains("[(, wel) -20 (come)] TJ"), "written back as the file had it: {c}");
    let (g0, g1) = (glyphs_of(&b, 0), glyphs_of(&e, 0));
    // Each kept character is still drawn by its own font.
    assert_eq!(at(&g1, "D", 0).3, "F1");
    assert_eq!(g1.iter().filter(|g| g.3 == "F2").map(|g| g.4.as_str()).collect::<String>(), "Sandhyayy");
    assert_eq!(at(&g1, "b", 0).3, "F3");
    // Before the caret nothing moved; after it everything on the line moved by the same amount,
    // the piece placed by itself too; the column and the second line stayed.
    let delta = at(&g1, ",", 0).1 - at(&g0, ",", 0).1;
    assert!((delta - 2.0 * 6.672).abs() < 0.01, "two bold y at 12 pt: {delta}");
    assert_eq!(at(&g1, "D", 0).1, at(&g0, "D", 0).1);
    assert!((at(&g1, "b", 0).1 - at(&g0, "b", 0).1 - delta).abs() < 0.01);
    assert!((at(&g1, "k", 0).1 - at(&g0, "k", 0).1 - delta).abs() < 0.01);
    assert!((at(&g1, "C", 0).1 - at(&g0, "C", 0).1).abs() < 0.005);
    assert!((at(&g1, "S", 1).1 - at(&g0, "S", 1).1).abs() < 0.005);
    // And the renderer agrees with where we say things are.
    let theirs = renderer_glyphs(e.clone(), 0);
    assert_eq!(theirs.len(), g1.len());
    for (o, t) in g1.iter().zip(&theirs) {
        assert!((o.1 - t.1).abs() < 0.05 && (o.2 - t.2).abs() < 0.05, "{o:?} against {t:?}");
    }
}

#[test]
fn a_selection_across_two_fonts_is_replaced_and_deleting_works() {
    let b = standard("BT /F1 12 Tf 72 700 Td (Dear ) Tj /F2 12 Tf (Sandhya) Tj /F1 12 Tf (, welcome) Tj ET");
    // "r San" (items 3..8) becomes "n": typed in the font of the first replaced letter.
    let e = edit(&b, 0, &[0, 3, 8], "n").unwrap();
    assert_eq!(lines_of(&e, 0), ["Deandhya, welcome"]);
    let g = glyphs_of(&e, 0);
    assert_eq!(at(&g, "n", 0).3, "F1");
    assert_eq!(at(&g, "y", 0).3, "F2");
    // The bold word goes entirely.
    let e = edit(&b, 0, &[0, 5, 12], "").unwrap();
    assert_eq!(lines_of(&e, 0), ["Dear , welcome"]);
    // Two changes in one line and typing at the very end.
    let e = edit(&b, 0, &[0, 0, 4, 0, 21, 21], "Hello\n!").unwrap();
    assert_eq!(lines_of(&e, 0), ["Hello Sandhya, welcome!"]);
}

fn print_like() -> Vec<u8> {
    // As "Microsoft: Print To PDF" writes: every run in its own q / cm / BT, a flipped page.
    let content = format!(
        "0.75 0 0 -0.75 0 792 cm\n\
         q 0.05 0 0 0.05 0 0 cm 0 0 0 rg BT 0 Tr /F2 320 Tf 1 0 0 -1 2000 3000 Tm [<{}>-3<{}>9<{}>] TJ ET Q\n\
         q 0.05 0 0 0.05 0 0 cm 0 0 0 rg BT 0 Tr /F1 320 Tf 1 0 0 -1 2000 4000 Tm [<{}>] TJ ET Q\n\
         q 0.04 0 0 0.04 0 0 cm 0.2 0.4 0.6 rg BT 0 Tr /F2 400 Tf 1 0 0 -1 2500 6000 Tm [<{}>-5<{}>] TJ ET Q",
        hex("Session: 2025"),
        hex(" - "),
        hex("2026"),
        hex("Roll no. 3007"),
        hex("Sandhya "),
        hex("Bhowmick"),
    );
    pdf(
        |doc| {
            let f1 = composite(doc, "CIDFont+F1", 400, "Roll no.307");
            let f2 = composite(doc, "ABCDEF+Arial-BoldMT", 700, "Session: 2025-6SandhyaBhowmick");
            dictionary! { "F1" => f1, "F2" => f2 }
        },
        &content,
    )
}

#[test]
fn glyph_numbered_text_is_edited_in_its_own_font() {
    let b = print_like();
    assert_eq!(lines_of(&b, 0), ["Session: 2025 - 2026", "Roll no. 3007", "Sandhya Bhowmick"]);
    // The last "k" of the name becomes "yy" (the recording's first edit).
    let e = edit(&b, 0, &[2, 15, 16], "yy").unwrap();
    assert_eq!(lines_of(&e, 0)[2], "Sandhya Bhowmicyy");
    let c = content(&e, 0).to_lowercase().replace(' ', "");
    let kept = hex("Bhowmick");
    let want = format!("<{}>-5<{}{}>", hex("Sandhya "), &kept[..kept.len() - 4], hex("yy")).to_lowercase();
    assert!(c.contains(&want), "same TJ, same font, kerning kept: {c} / {want}");
    assert!(!c.contains("gmbe"), "no stand-in font was needed: {c}");
    let fonts = super::line_fonts(&e, 0, 2);
    assert!(fonts.split('|').all(|f| f.starts_with("F2:ABCDEF+Arial-BoldMT:bold:12.00")), "{fonts}");
}

#[test]
fn a_character_the_font_lacks_comes_in_the_same_weight_and_the_line_can_be_edited_again() {
    let b = print_like();
    // "2026" becomes "2027": this bold font has no 7 (the regular one has, which must not matter).
    let e = edit(&b, 0, &[0, 19, 20], "7").unwrap();
    assert_eq!(lines_of(&e, 0)[0], "Session: 2025 - 2027");
    let fonts = super::line_fonts(&e, 0, 0);
    let last = fonts.split('|').last().unwrap();
    assert!(last.contains(":Helvetica-Bold:bold:"), "bold stays bold: {last}");
    assert!(fonts.split('|').take(19).all(|f| f.starts_with("F2:")), "{fonts}");
    let (g0, g1) = (glyphs_of(&b, 0), glyphs_of(&e, 0));
    for i in 0..19 {
        assert_eq!((g0[i].0, g0[i].1, g0[i].2), (g1[i].0, g1[i].1, g1[i].2), "character {i} kept its code and place");
    }
    assert!((g1[19].1 - g0[19].1).abs() < 0.005 && (g1[19].2 - g0[19].2).abs() < 0.005, "the 7 stands where the 6 stood");
    // Again, in the middle this time, across the stand-in: "25 - 2027" becomes "30".
    let e2 = edit(&e, 0, &[0, 11, 20], "30").unwrap();
    assert_eq!(lines_of(&e2, 0)[0], "Session: 2030");
    // One stand-in font per look and page, also after another such edit.
    let e3 = edit(&e, 0, &[0, 0, 0], "7").unwrap();
    assert_eq!(lines_of(&e3, 0)[0], "7Session: 2025 - 2027");
    let d = Document::load_mem(&e3).unwrap();
    assert_eq!(d.objects.values().filter(|o| o.as_dict().ok().and_then(|x| x.get(b"BaseFont").ok()).and_then(|n| n.as_name().ok()) == Some(&b"Helvetica-Bold"[..])).count(), 1);
    // The other lines never moved.
    let g3 = glyphs_of(&e3, 0);
    assert_eq!(at(&g3, "R", 0).1, at(&g0, "R", 0).1);
    assert_eq!(at(&g3, "k", 0).1, at(&g0, "k", 0).1);
}

#[test]
fn quote_operators_and_word_spacing_survive() {
    let b = standard("BT /F1 12 Tf 14 TL 72 700 Td (First line) Tj (Second line here) ' 2 0.5 (Third one) \" ET");
    assert_eq!(lines_of(&b, 0), ["First line", "Second line here", "Third one"]);
    let e = edit(&b, 0, &[1, 7, 11, 2, 0, 5], "row\nLast").unwrap();
    assert_eq!(lines_of(&e, 0), ["First line", "Second row here", "Last one"]);
    let (g0, g1) = (glyphs_of(&b, 0), glyphs_of(&e, 0));
    assert_eq!((at(&g0, "S", 0).1, at(&g0, "S", 0).2), (at(&g1, "S", 0).1, at(&g1, "S", 0).2));
    assert_eq!(at(&g0, "T", 0).2, at(&g1, "L", 0).2);
}

/// Any PDF on this machine, when its path is given (never copied into the repository):
/// GMB_SAMPLE_PDF=path GMB_SAMPLE_EDITS="old=>new;old2=>new2" cargo test --release sample -- --nocapture
/// Reads page 1, checks this module against the renderer, makes the edits and says which font
/// draws each edited line before and after. GMB_SAMPLE_OUT=path writes the result.
#[test]
fn a_sample_file_keeps_its_fonts() {
    let Ok(path) = std::env::var("GMB_SAMPLE_PDF") else { return };
    let b = std::fs::read(path).unwrap();
    let lines = lines_of(&b, 0);
    for (i, l) in lines.iter().enumerate() {
        println!("{i}: {l}  [{}]", super::line_fonts(&b, 0, i as u32).split('|').next().unwrap_or(""));
    }
    let ours = glyphs_of(&b, 0);
    let theirs = renderer_glyphs(b.clone(), 0);
    assert_eq!(ours.len(), theirs.len(), "as many characters as the renderer draws");
    for (o, t) in ours.iter().zip(&theirs) {
        assert!(o.0 == t.0 && (o.1 - t.1).abs() < 0.05 && (o.2 - t.2).abs() < 0.05, "{o:?} against {t:?}");
    }
    let edits = std::env::var("GMB_SAMPLE_EDITS").unwrap_or_default();
    let mut spans = Vec::new();
    let mut texts = Vec::new();
    let mut expect = Vec::new();
    for pair in edits.split(';').filter(|p| p.contains("=>")) {
        let (old, new) = pair.split_once("=>").unwrap();
        let li = lines.iter().position(|l| l.contains(old)).unwrap_or_else(|| panic!("no line holds {old}"));
        // The longest shared start and end stay: only the middle is replaced, as the editor does.
        let (o, n): (Vec<char>, Vec<char>) = (old.chars().collect(), new.chars().collect());
        let pre = o.iter().zip(&n).take_while(|(x, y)| x == y).count();
        let suf = o[pre..].iter().rev().zip(n[pre..].iter().rev()).take_while(|(x, y)| x == y).count();
        let start = lines[li][..lines[li].find(old).unwrap()].chars().count();
        spans.extend([li as u32, (start + pre) as u32, (start + o.len() - suf) as u32]);
        texts.push(n[pre..n.len() - suf].iter().collect::<String>());
        expect.push((li, lines[li].replacen(old, new, 1)));
    }
    if spans.is_empty() {
        return;
    }
    let t0 = std::time::Instant::now();
    let e = edit(&b, 0, &spans, &texts.join("\n")).unwrap();
    println!("edit took {:?}", t0.elapsed());
    if let Ok(out) = std::env::var("GMB_SAMPLE_OUT") {
        std::fs::write(out, &e).unwrap();
    }
    let after = lines_of(&e, 0);
    for (i, l) in after.iter().enumerate() {
        println!("after {i}: {l}");
    }
    for (li, want) in &expect {
        assert_eq!(&after[*li], want);
        println!("line {li} before: {}", super::line_fonts(&b, 0, *li as u32));
        println!("line {li} after:  {}", super::line_fonts(&e, 0, *li as u32));
    }
    let (g1, r1) = (glyphs_of(&e, 0), renderer_glyphs(e.clone(), 0));
    assert_eq!(g1.len(), r1.len());
    for (o, t) in g1.iter().zip(&r1) {
        assert!(o.0 == t.0 && (o.1 - t.1).abs() < 0.05 && (o.2 - t.2).abs() < 0.05, "after the edit: {o:?} against {t:?}");
    }
    // A picture of the edited page (PPM), to look at.
    if let Ok(out) = std::env::var("GMB_SAMPLE_SHOT") {
        let px = super::Viewer::new(e.clone()).ok().unwrap().render(0, 2.0);
        let (w, h) = (u32::from_le_bytes(px[0..4].try_into().unwrap()), u32::from_le_bytes(px[4..8].try_into().unwrap()));
        let mut ppm = format!("P6 {w} {h} 255\n").into_bytes();
        px[8..].chunks(4).for_each(|c| ppm.extend_from_slice(&c[..3]));
        std::fs::write(out, ppm).unwrap();
    }
}

#[test]
fn standard_widths_are_known_for_accented_letters_too() {
    let w = widths_of("Helvetica", "WinAnsiEncoding");
    let mut missing: Vec<u32> = (32u32..=255).filter(|c| w.get(c).copied().unwrap_or(0.0) <= 0.0).collect();
    missing.retain(|c| ![127, 129, 141, 143, 144, 157].contains(c));
    assert!(missing.is_empty(), "no width for {missing:?}");
    assert!((w[&65] - 667.0).abs() < 1.0 && (w[&235] - 556.0).abs() < 1.0 && (w[&32] - 278.0).abs() < 1.0, "{:?} {:?} {:?}", w[&65], w[&235], w[&32]);
    let b = widths_of("Times-Bold", "WinAnsiEncoding");
    assert!((b[&65] - 722.0).abs() < 1.0 && (b[&46] - 250.0).abs() < 1.0);
}

#[test]
fn a_missing_letter_comes_from_the_same_typeface_on_another_page() {
    // Two pages, each with its own copy of Arial Bold holding only the letters that page uses.
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let f_a = composite(&mut doc, "ABCDEF+Arial-BoldMT", 700, "Session: 2025-6");
    let f_b = composite(&mut doc, "GHIJKL+Arial-BoldMT", 700, "Page 7");
    let f_c = composite(&mut doc, "MNOPQR+Arial-ItalicMT", 400, "7");
    let mut kids = Vec::new();
    for (fonts, text) in [(dictionary! { "F2" => f_a }, "Session: 2026"), (dictionary! { "F7" => f_b, "F8" => f_c }, "Page 7")] {
        let c = doc.add_object(Stream::new(dictionary! {}, format!("BT /{} 12 Tf 72 700 Td <{}> Tj ET", if text.starts_with('S') { "F2" } else { "F7" }, hex(text)).into_bytes()));
        kids.push(Object::Reference(doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages_id, "Contents" => c, "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()], "Resources" => dictionary! { "Font" => fonts } })));
    }
    doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => 2 }));
    let cat = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", cat);
    let mut b = vec![];
    doc.save_to(&mut b).unwrap();
    let e = edit(&b, 0, &[0, 12, 13], "7").unwrap();
    assert_eq!(lines_of(&e, 0), ["Session: 2027"]);
    let fonts = super::line_fonts(&e, 0, 0);
    let last = fonts.split('|').last().unwrap();
    assert!(last.contains(":GHIJKL+Arial-BoldMT:bold:"), "the 7 is page 2's Arial Bold, not its italic and not a stand-in: {last}");
    assert_eq!(lines_of(&e, 1), ["Page 7"]);
}

#[test]
fn typing_at_the_start_of_a_bold_word_can_be_bold() {
    let b = standard("BT /F1 12 Tf 72 700 Td (Dear ) Tj /F2 12 Tf (Sandhya) Tj ET");
    // Between the space and the S: by default like the space before it, on request like the S.
    let plain = edit_sided(&b, 0, &[0, 5, 5, 0], "Mr ").unwrap();
    let bold = edit_sided(&b, 0, &[0, 5, 5, 1], "Mr ").unwrap();
    assert_eq!(lines_of(&plain, 0), ["Dear Mr Sandhya"]);
    assert_eq!(lines_of(&bold, 0), ["Dear Mr Sandhya"]);
    assert_eq!(at(&glyphs_of(&plain, 0), "M", 0).3, "F1");
    assert_eq!(at(&glyphs_of(&bold, 0), "M", 0).3, "F2");
    // A gap that only reads as a space (no character in the file) can be closed and typed into.
    let gap = standard("BT /F1 12 Tf 72 700 Td [(Left) -600 (Right)] TJ ET");
    assert_eq!(lines_of(&gap, 0), ["Left Right"]);
    let e = edit(&gap, 0, &[0, 4, 5], "").unwrap();
    assert_eq!(lines_of(&e, 0), ["LeftRight"]);
    let e = edit(&gap, 0, &[0, 4, 5], " and ").unwrap();
    assert_eq!(lines_of(&e, 0), ["Left and Right"]);
}

#[test]
fn underlines_and_strike_through_lines_follow_the_text() {
    // As a browser writes it: the underline is a thin filled rectangle of its own, cut where a
    // letter reaches below the line by a hole in the clipping path; a struck word has a stroked
    // line through it. A rule right across the page and a table border are not the text's.
    let page = "q 0 0 612 792 re W n 612 0 m 0 0 l 0 792 l 612 792 l 612 0 l h 131 696 m 126 696 l 126 699 l 131 699 l 131 696 l h W* n 0 0 1 rg 104 697.5 56 1 re f Q\n\
        BT /F1 12 Tf 72 700 Td (Read ) Tj 0 0 1 rg (the report) Tj 0 g ( and ) Tj (sign) Tj ( it) Tj ET\n\
        0.5 w 181.38 704 m 200.05 704 l S\n\
        20 690 572 0.5 re f\n\
        BT /F1 12 Tf 72 660 Td (Next line) Tj ET";
    let b = standard(page);
    assert_eq!(lines_of(&b, 0), ["Read the report and sign it", "Next line"]);
    // "the" (items 5..8) becomes "this long": 9 letters for 3, inside the underlined words.
    let e = edit(&b, 0, &[0, 5, 8], "this long").unwrap();
    assert_eq!(lines_of(&e, 0), ["Read this long report and sign it", "Next line"]);
    let (g0, g1) = (glyphs_of(&b, 0), glyphs_of(&e, 0));
    let delta = at(&g1, "p", 0).1 - at(&g0, "p", 0).1;
    assert!(delta > 20.0, "{delta}");
    let c = content(&e, 0);
    let numbers = |line: &str| -> Vec<f64> { line.split_whitespace().filter_map(|x| x.parse().ok()).collect() };
    // The underline starts where it started and is longer by the change.
    let under = c.lines().find(|l| l.contains(" re") && l.starts_with("104 ")).map(numbers).unwrap_or_else(|| panic!("{c}"));
    assert!((under[2] - 56.0 - delta).abs() < 0.01, "underline is {} wide, text grew by {delta}: {c}", under[2]);
    // The hole for the p moved with the p.
    let hole: Vec<Vec<f64>> = c.lines().filter(|l| l.ends_with(" 696 m") || l.ends_with(" 696 l") || l.ends_with(" 699 l")).map(numbers).collect();
    assert_eq!(hole.len(), 5, "{c}");
    assert!((hole[0][0] - 131.0 - delta).abs() < 0.01 && (hole[1][0] - 126.0 - delta).abs() < 0.01, "{hole:?} {delta}");
    // The line through "sign" moved with it, as long as before.
    let strike: Vec<Vec<f64>> = c.lines().filter(|l| l.ends_with(" 704 m") || l.ends_with(" 704 l")).map(numbers).collect();
    assert!((strike[0][0] - 181.38 - delta).abs() < 0.01 && (strike[1][0] - 200.05 - delta).abs() < 0.01, "{strike:?}");
    // The page's own clip, the rule across the page and the other line are as they were.
    assert!(c.contains("612 0 m
0 0 l
0 792 l
612 792 l
612 0 l
h"), "{c}");
    assert!(c.contains("20 690 572 0.5 re
f"), "{c}");
    assert_eq!(at(&g1, "N", 0).1, at(&g0, "N", 0).1);
    // Typed at the end of the underlined words ("report" ends at item 15): the underline grows.
    let e = edit(&b, 0, &[0, 15, 15], "s").unwrap();
    let c = content(&e, 0);
    let under = c.lines().find(|l| l.contains(" re") && l.starts_with("104 ")).map(numbers).unwrap();
    assert!(under[2] > 61.0, "{c}");
    // Typed before them, in the plain text: it only moves.
    let e = edit(&b, 0, &[0, 0, 4], "Please read").unwrap();
    let c = content(&e, 0);
    let under = c.lines().find(|l| l.contains(" re") && l.contains(" 697.5 ")).map(numbers).unwrap();
    assert!(under[0] > 120.0 && (under[2] - 56.0).abs() < 0.01, "{c}");
}

#[test]
fn a_letter_the_file_lacks_comes_from_this_computers_own_font() {
    // A font this machine has (Arial on Windows, DejaVu on Linux); elsewhere there is nothing to check.
    let Some(file) = ["C:/Windows/Fonts/arialbd.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"].iter().find_map(|p| std::fs::read(p).ok()) else { return };
    let ps = if file.len() > 900_000 { "Arial-BoldMT" } else { "DejaVuSans-Bold" };
    let b = pdf(
        |doc| {
            let f2 = composite(doc, &format!("ABCDEF+{ps}"), 700, "Session: 2025-6");
            dictionary! { "F2" => f2 }
        },
        &format!("BT /F2 12 Tf 72 700 Td <{}> Tj ET BT /F2 12 Tf 72 680 Td <{}> Tj ET", hex("Session: 2026"), hex("2025")),
    );
    // What is missing is named with the face it should come in.
    let need = missing(&b, 0, &[0, 12, 13], "7Q");
    assert!(need.contains(&format!("\"ps\":\"{ps}\"")) && need.contains("\"chars\":\"7Q\"") && need.contains("\"bold\":true"), "{need}");
    assert_eq!(missing(&b, 0, &[0, 12, 13], "5"), "[]");
    let e = edit_with_fonts(&b, 0, &[0, 12, 13], "7Q", &[file.clone()]).unwrap();
    assert_eq!(lines_of(&e, 0), ["Session: 2027Q", "2025"]);
    let fonts = super::line_fonts(&e, 0, 0);
    let last = fonts.split('|').last().unwrap();
    assert!(last.contains(&format!("+{ps}:bold:12.00")) && last.starts_with("GmbL"), "the new letters are in the real face: {last}");
    assert!(fonts.split('|').take(12).all(|f| f.starts_with("F2:")), "{fonts}");
    // Only the glyphs used went into the file, and the renderer draws them where we say.
    assert!(e.len() < b.len() + 40_000, "the file grew by {} bytes for two letters", e.len() - b.len());
    let (ours, theirs) = (glyphs_of(&e, 0), renderer_glyphs(e.clone(), 0));
    assert_eq!(ours.len(), theirs.len());
    for (o, t) in ours.iter().zip(&theirs) {
        assert!(o.0 == t.0 && (o.1 - t.1).abs() < 0.05 && (o.2 - t.2).abs() < 0.05, "{o:?} against {t:?}");
    }
    // The letters really are drawn: the page has ink where the 7 stands.
    let px = super::Viewer::new(e.clone()).ok().unwrap().render(0, 2.0);
    let w = u32::from_le_bytes(px[0..4].try_into().unwrap()) as usize;
    let seven = at(&ours, "7", 0);
    let dark = (0..18).flat_map(|dy| (0..12).map(move |dx| (dx, dy))).filter(|(dx, dy)| px[8 + (((seven.2 * 2.0) as usize - dy) * w + (seven.1 * 2.0) as usize + 1 + dx) * 4] < 128).count();
    assert!(dark > 10, "no ink where the 7 should be ({dark})");
    // Typed again later: the font in the file now has the 7; a new letter makes another small part.
    assert_eq!(missing(&e, 0, &[1, 4, 4], "7"), "[]");
    let e2 = edit(&e, 0, &[1, 4, 4], "7").unwrap();
    assert_eq!(lines_of(&e2, 0)[1], "20257");
    assert!(super::line_fonts(&e2, 0, 1).split('|').last().unwrap().contains(&format!("+{ps}:bold")));
}
