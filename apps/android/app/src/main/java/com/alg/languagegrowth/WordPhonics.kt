package com.alg.languagegrowth

/**
 * 当前 M1 课程词表的最小音标表。
 *
 * 服务端课堂指令只携带目标词与音节切分，不携带音标；在课程数据补齐
 * `phonetic` 字段前，客户端用这张表保证 M1 核心词能显示标准 IPA。
 * 查找时忽略大小写与首尾标点，未知词不猜测、不伪造音标。
 */
internal object WordPhonics {
    private val ipa = mapOf(
        "hello" to "/həˈloʊ/",
        "hi" to "/haɪ/",
        "bye" to "/baɪ/",
        "yes" to "/jes/",
        "no" to "/noʊ/",
        "please" to "/pliːz/",
        "thank you" to "/ˈθæŋk juː/",
        "sorry" to "/ˈsɑːri/",
        "goodbye" to "/ˌɡʊdˈbaɪ/",
        "good morning" to "/ˌɡʊd ˈmɔːnɪŋ/",
        "i" to "/aɪ/",
        "my" to "/maɪ/",
        "name" to "/neɪm/",
        "am" to "/æm/",
        "is" to "/ɪz/",
        "boy" to "/bɔɪ/",
        "girl" to "/ɡɜːrl/",
        "nine" to "/naɪn/",
        "friend" to "/frend/",
        "nice" to "/naɪs/",
        "meet" to "/miːt/",
        "apple" to "/ˈæpl/",
        "banana" to "/bəˈnɑːnə/",
        "ball" to "/bɔːl/",
        "book" to "/bʊk/",
        "cup" to "/kʌp/",
        "cat" to "/kæt/",
        "dog" to "/dɔːɡ/",
        "red" to "/red/",
        "blue" to "/bluː/",
        "green" to "/ɡriːn/",
        "like" to "/laɪk/",
        "this" to "/ðɪs/",
    )

    fun of(word: String): String {
        val key = word.trim().trim('.', ',', '!', '?', '"', '\'').lowercase()
        return ipa[key].orEmpty()
    }
}
