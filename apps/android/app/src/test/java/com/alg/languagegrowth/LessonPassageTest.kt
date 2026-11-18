package com.alg.languagegrowth

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LessonPassageTest {
    @Test
    fun parsesSentencesAndBothPlaybackSpeeds() {
        val raw = JSONObject(
            """
            {
              "unitId": "unit-1",
              "topicId": "topic-1",
              "contentVersion": "v3",
              "audioReady": true,
              "title": "At the Park",
              "paragraphs": [
                {
                  "sentences": [
                    {
                      "id": "s1",
                      "en": "I see a red kite.",
                      "zh": "我看见一只红风筝。",
                      "audio": {
                        "normalRef": "/api/v1/media/audio/aaaaaaaaaaaaaaaaaaaaaaaa.mp3",
                        "slowRef": "/api/v1/media/audio/bbbbbbbbbbbbbbbbbbbbbbbb.mp3"
                      }
                    },
                    {
                      "id": "s2",
                      "en": "It is high in the sky.",
                      "zh": "它在天空中飞得很高。",
                      "audio": {
                        "normalRef": "/api/v1/media/audio/cccccccccccccccccccccccc.mp3"
                      }
                    }
                  ]
                }
              ]
            }
            """.trimIndent(),
        )

        val passage = parseLessonPassage(raw)!!

        assertEquals("At the Park", passage.title)
        assertEquals(2, passage.sentences.size)
        assertEquals("我看见一只红风筝。", passage.sentences.first().chinese)
        assertEquals(
            listOf("s1", "s2"),
            passage.playbackItems(slow = false).map { it.sentenceId },
        )
        assertEquals(
            listOf("s1"),
            passage.playbackItems(slow = true).map { it.sentenceId },
        )
    }

    @Test
    fun keepsTextWhenAudioIsMissingOrUnsafe() {
        val raw = JSONObject(
            """
            {
              "title": "Safe Reading",
              "paragraphs": [
                {
                  "sentences": [
                    {
                      "id": "s1",
                      "en": "Read this sentence.",
                      "zh": "读这一句。",
                      "audio": {
                        "normalRef": "https://evil.example/audio.mp3",
                        "slowRef": "/api/v1/media/audio/not-a-hash.mp3"
                      }
                    }
                  ]
                }
              ]
            }
            """.trimIndent(),
        )

        val passage = parseLessonPassage(raw)!!

        assertEquals(1, passage.sentences.size)
        assertNull(passage.sentences.single().audio.normalRef)
        assertNull(passage.sentences.single().audio.slowRef)
        assertTrue(passage.playbackItems(slow = false).isEmpty())
        assertTrue(passage.playbackItems(slow = true).isEmpty())
    }

    @Test
    fun ignoresLegacyResponseWithoutPassage() {
        assertNull(parseLessonPassage(null))
        assertNull(parseLessonPassage(JSONObject("""{"title":"No passage"}""")))
        assertNull(parseLessonPassage(JSONObject("""{"paragraphs":[]}""")))
    }
}
