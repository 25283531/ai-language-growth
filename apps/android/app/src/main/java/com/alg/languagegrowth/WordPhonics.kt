package com.alg.languagegrowth

/**
 * 当前 M1 课程词表的最小音标表。
 *
 * 服务端课堂指令只携带目标词与音节切分，不携带音标；在课程数据补齐
 * `phonetic` 字段前，客户端用这张表保证 M1 核心词能显示标准 IPA。
 * 查找时忽略大小写与首尾标点，未知词不猜测、不伪造音标。
 *
 * 这里只存 IPA 本体，不存两侧的斜杠；展示层再加 `/…/`，避免 IPA
 * 字面量被静态守卫误识别成 API 路径。
 */
internal object WordPhonics {
    private val ipa = mapOf(
        "hello" to "həˈloʊ",
        "hi" to "haɪ",
        "bye" to "baɪ",
        "yes" to "jes",
        "no" to "noʊ",
        "please" to "pliːz",
        "thank you" to "ˈθæŋk juː",
        "sorry" to "ˈsɑːri",
        "goodbye" to "ˌɡʊdˈbaɪ",
        "good morning" to "ˌɡʊd ˈmɔːnɪŋ",
        "i" to "aɪ",
        "my" to "maɪ",
        "name" to "neɪm",
        "am" to "æm",
        "is" to "ɪz",
        "boy" to "bɔɪ",
        "girl" to "ɡɜːrl",
        "nine" to "naɪn",
        "friend" to "frend",
        "nice" to "naɪs",
        "meet" to "miːt",
        "apple" to "ˈæpl",
        "banana" to "bəˈnɑːnə",
        "ball" to "bɔːl",
        "book" to "bʊk",
        "cup" to "kʌp",
        "cat" to "kæt",
        "dog" to "dɔːɡ",
        "red" to "red",
        "blue" to "bluː",
        "green" to "ɡriːn",
        "like" to "laɪk",
        "this" to "ðɪs",
    )

    /** 字母组合与发音的对应关系；只给已确认的 M1 词，不猜未收录的词。 */
    private val partsMap = mapOf(
        "hello" to listOf("h" to "h", "e" to "ə", "ll" to "l", "o" to "oʊ"),
        "hi" to listOf("h" to "h", "i" to "aɪ"),
        "bye" to listOf("b" to "b", "y" to "aɪ", "e" to "不发音"),
        "goodbye" to listOf("good" to "ɡʊd", "b" to "b", "y" to "aɪ", "e" to "不发音"),
        "yes" to listOf("y" to "j", "e" to "e", "s" to "s"),
        "no" to listOf("n" to "n", "o" to "oʊ"),
        "name" to listOf("n" to "n", "a" to "eɪ", "me" to "m（e 不发音）"),
        "nice" to listOf("n" to "n", "i" to "aɪ", "c" to "s", "e" to "不发音"),
        "nine" to listOf("n" to "n", "i" to "aɪ", "n" to "n", "e" to "不发音"),
        "like" to listOf("l" to "l", "i" to "aɪ", "k" to "k", "e" to "不发音"),
        "meet" to listOf("m" to "m", "ee" to "iː", "t" to "t"),
        "green" to listOf("g" to "ɡ", "r" to "r", "ee" to "iː", "n" to "n"),
        "please" to listOf("p" to "p", "l" to "l", "ea" to "iː", "se" to "z"),
        "thank you" to listOf("th" to "θ", "ank" to "æŋk", "y" to "j", "ou" to "uː"),
        "sorry" to listOf("s" to "s", "o" to "ɑː", "rr" to "r", "y" to "i"),
        "apple" to listOf("a" to "æ", "pp" to "p", "le" to "l"),
        "banana" to listOf("ba" to "bə", "na" to "nɑː", "na" to "nə"),
        "cat" to listOf("c" to "k", "a" to "æ", "t" to "t"),
        "dog" to listOf("d" to "d", "o" to "ɔː", "g" to "ɡ"),
        "book" to listOf("b" to "b", "oo" to "ʊ", "k" to "k"),
        "red" to listOf("r" to "r", "e" to "e", "d" to "d"),
        "blue" to listOf("bl" to "bl", "ue" to "uː"),
        "friend" to listOf("fr" to "fr", "ie" to "e", "nd" to "nd"),
    )

    fun of(word: String): String {
        val key = word.trim().trim('.', ',', '!', '?', '"', '\'').lowercase()
        return ipa[key].orEmpty()
    }

    fun parts(word: String): List<Pair<String, String>> {
        val key = word.trim().trim('.', ',', '!', '?', '"', '\'').lowercase()
        return partsMap[key] ?: listOf(key to "按音节慢慢读")
    }
}
