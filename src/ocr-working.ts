import * as fs from 'fs';
import * as path from 'path';
import tesseract from 'node-tesseract-ocr';

interface MCQOption {
  id: string;
  text: string;
}

interface MCQQuestion {
  questionId: string;
  filename: string;
  question: string;
  options: MCQOption[];
  rawText?: string;
}

class OCRMCQExtractor {
  async extractTextFromImage(imagePath: string): Promise<string> {
    try {
      const text = await tesseract.recognize(imagePath, {
        lang: 'eng',
        oem: 1,  // OCR Engine Mode: Neural nets LSTM engine only
        psm: 3,  // Page Segmentation Mode: Fully automatic page segmentation
      });
      return text;
    } catch (error) {
      throw new Error(`OCR failed for ${imagePath}: ${error}`);
    }
  }

  parseMCQFromText(text: string, filename: string): MCQQuestion | null {
    try {
      // Clean up the text - handle common OCR artifacts
      let cleanText = text
        .replace(/\n+/g, ' ')           // Replace multiple newlines with single space
        .replace(/\s+/g, ' ')           // Replace multiple spaces with single space
        .replace(/[|]/g, 'I')           // Common OCR mistake: | instead of I
        .trim();
      
      // Extract question ID (pattern like Q302, Q123, etc.)
      const questionIdPattern = /(?:^|\s)([QE]\d{2,4})\b/i;
      const questionIdMatch = cleanText.match(questionIdPattern);
      const questionId = questionIdMatch?.[1] || `Q_${filename.replace('.png', '')}`;
      
      // Find the main question text
      // Strategy: Extract everything from question ID to the final question mark or before options
      let questionText = '';
      
      // Remove the question ID prefix to get clean text
      let textAfterQuestionId = cleanText;
      const qIdMatch = cleanText.match(/(?:^|\s)([QE]\d{2,4})\b\.?\s*/i);
      if (qIdMatch && qIdMatch.index !== undefined) {
        textAfterQuestionId = cleanText.substring(qIdMatch.index + qIdMatch[0].length);
      }
      
      // Strategy 1: Take everything before the first option or before unlabeled option text
      // Look for the end of question context - before options start
      const optionStartPatterns = [
        /(?=\s*\([A-D]\))/i,                    // Before (A), (B), etc
        /(?=\s*[A-D][\)\.])/i,                  // Before A), B), etc  
        /(?=\s*Upload\s+the\s+data)/i,          // Before typical option text
        /(?=\s*Use\s+a\s+subset)/i,             // Before typical option text
        /(?=\s*Send\s+the)/i,                   // Before typical option text
        /(?=\s*Create)/i,                       // Before typical option text
      ];
      
      let questionEndIndex = textAfterQuestionId.length;
      for (const pattern of optionStartPatterns) {
        const match = pattern.exec(textAfterQuestionId);
        if (match && match.index !== undefined && match.index < questionEndIndex) {
          questionEndIndex = match.index;
        }
      }
      
      const beforeOptions = textAfterQuestionId.substring(0, questionEndIndex).trim();
      if (beforeOptions && beforeOptions.length > 50) {
        questionText = beforeOptions;
      }
      
      // Strategy 2: If that didn't work, look for text ending with a question mark
      if (!questionText) {
        const questionWithMark = textAfterQuestionId.match(/(.*\?)/s);
        if (questionWithMark?.[1]) {
          questionText = questionWithMark[1].trim();
        }
      }
      
      // Strategy 3: Fallback - take substantial text from the beginning
      if (!questionText) {
        const fallbackText = textAfterQuestionId.substring(0, 500).trim();
        if (fallbackText.length > 50) {
          questionText = fallbackText;
        }
      }
      
      // Clean up question text
      questionText = questionText
        .replace(/^[^a-zA-Z]*/, '')     // Remove leading non-letters
        .replace(/\s+/g, ' ')           // Normalize spaces
        .trim();
      
      // Extract options using simpler approach
      const options: MCQOption[] = [];
      
      // Look for A) B) C) D) pattern
      const optionPatterns = [
        'A', 'B', 'C', 'D'
      ];
      
      // First, try to extract options with labels (A), (B), (C), (D)
      for (const letter of optionPatterns) {
        const patterns = [
          new RegExp(`\\(${letter}\\)\\s*([^\\(]*?)(?=\\s*\\([A-D]\\)|$)`, 'i'),
          new RegExp(`\\s${letter}[\\)\\.]\\s*([^A-D]*?)(?=\\s*[A-D][\\)\\.]|$)`, 'i'),
          new RegExp(`${letter}[\\)\\.]\\s*([^\\n]*?)(?=\\s*[A-D][\\)\\.]|$)`, 'i')
        ];
        
        let optionText = '';
        for (const pattern of patterns) {
          const match = cleanText.match(pattern);
          if (match?.[1] && match[1].trim().length > optionText.length) {
            optionText = match[1].trim();
          }
        }
        
        if (optionText) {
          optionText = optionText
            .replace(/\s+/g, ' ')
            .replace(/^[^a-zA-Z]*/, '')
            .trim();
          
          if (optionText.length > 5) {
            options.push({
              id: letter,
              text: optionText
            });
          }
        }
      }
      
      // If we're missing options, try to find unlabeled text blocks
      if (options.length < 4) {
        console.warn(`Only found ${options.length} labeled options, looking for unlabeled text blocks...`);
        
        const foundIds = new Set(options.map(opt => opt.id.toUpperCase()));
        const missingIds = ['A', 'B', 'C', 'D'].filter(id => !foundIds.has(id));
        
        if (missingIds.length > 0) {
          // Strategy: Analyze text structure to find unlabeled options
          // Look for text segments that appear between known options or after question
          
          console.warn(`Missing option IDs: ${missingIds.join(', ')}`);
          
          // Create markers for known positions in the text
          const optionPositions: Array<{id: string, start: number, end: number}> = [];
          
          for (const option of options) {
            const pattern = new RegExp(`\\(${option.id}\\)`, 'i');
            const match = cleanText.match(pattern);
            if (match && match.index !== undefined) {
              optionPositions.push({
                id: option.id,
                start: match.index,
                end: match.index + match[0].length
              });
            }
          }
          
          // Sort by position in text
          optionPositions.sort((a, b) => a.start - b.start);
          
          // Look for text segments that could be unlabeled options
          const candidateTexts: string[] = [];
          
          // Strategy 1: Look for text between option markers
          for (let i = 0; i < optionPositions.length - 1; i++) {
            const currentOption = optionPositions[i];
            const nextOption = optionPositions[i + 1];
            
            // Extract text between this option and the next
            const betweenText = cleanText.substring(
              currentOption.end,
              nextOption.start
            ).trim();
            
            // Look for substantial text that looks like an option
            if (betweenText.length > 50) {
              // Split by common sentence endings and take meaningful chunks  
              const chunks = betweenText.split(/[.!?]\s+/)
                .filter(chunk => chunk.trim().length > 30);
              
              for (const chunk of chunks) {
                const cleanChunk = chunk.trim().replace(/\s+/g, ' ');
                
                // Check if this looks like an option (contains action words)
                if (cleanChunk.match(/^(Use|Send|Create|Build|Configure|Train|Deploy|Implement)/i) ||
                    cleanChunk.includes('Amazon') ||
                    cleanChunk.includes('API')) {
                  candidateTexts.push(cleanChunk);
                  break; // Only take first valid chunk from this segment
                }
              }
            }
          }
          
          // Strategy 2: If we still don't have enough, look for action-verb sentences
          if (candidateTexts.length < missingIds.length) {
            const actionSentences = cleanText.match(/(?:^|\s)((?:Use|Send|Create|Build|Configure|Train|Deploy|Implement)[^.!?]*[.!?]?)/gi) || [];
            
            for (const sentence of actionSentences) {
              const cleanSentence = sentence.trim().replace(/\s+/g, ' ');
              
              // Skip if already found in options or candidates
              const alreadyFound = [...options, ...candidateTexts.map(t => ({text: t}))].some(item =>
                item.text.toLowerCase().substring(0, 30) === cleanSentence.toLowerCase().substring(0, 30)
              );
              
              if (!alreadyFound && cleanSentence.length > 40) {
                candidateTexts.push(cleanSentence);
              }
            }
          }
          
          // Assign candidates to missing IDs
          for (let i = 0; i < Math.min(missingIds.length, candidateTexts.length); i++) {
            const missingId = missingIds[i];
            const candidateText = candidateTexts[i];
            
            options.push({
              id: missingId,
              text: candidateText
            });
            console.log(`Found unlabeled option ${missingId}: "${candidateText.substring(0, 50)}..."`);
          }
        }
        
        // Sort options by ID
        options.sort((a, b) => a.id.localeCompare(b.id));
      }
      
      // Validate we have meaningful content
      if (!questionText || questionText.length < 20) {
        console.warn(`Warning: Question text too short for ${filename}: "${questionText}"`);
      }
      
      if (options.length < 2) {
        console.warn(`Warning: Only found ${options.length} options for ${filename}`);
      }
      
      return {
        questionId,
        filename,
        question: questionText,
        options,
        rawText: text
      };
      
    } catch (error) {
      console.error(`Error parsing MCQ from ${filename}:`, error);
      return null;
    }
  }

  async processDirectory(directoryPath: string): Promise<MCQQuestion[]> {
    const files = fs.readdirSync(directoryPath);
    const pngFiles = files.filter(file => path.extname(file).toLowerCase() === '.png');
    
    if (pngFiles.length === 0) {
      console.log('No PNG files found in the directory.');
      return [];
    }
    
    console.log(`Processing ${pngFiles.length} PNG files with OCR...`);
    const questions: MCQQuestion[] = [];
    
    for (const file of pngFiles) {
      const filePath = path.join(directoryPath, file);
      console.log(`\nExtracting text from: ${file}`);
      
      try {
        const text = await this.extractTextFromImage(filePath);
        console.log(`Raw OCR text preview: "${text.substring(0, 100)}..."`);
        
        const mcq = this.parseMCQFromText(text, file);
        
        if (mcq && mcq.question && mcq.options.length > 0) {
          questions.push(mcq);
          console.log(`✓ Extracted question: ${mcq.questionId} (${mcq.options.length} options)`);
          console.log(`Options found: ${mcq.options.map(opt => opt.id).join(', ')}`);
        } else {
          console.log(`✗ Failed to parse MCQ structure from: ${file}`);
          // Show first part of raw text for debugging
          console.log(`Raw text sample: "${text.substring(0, 200)}..."`);
        }
      } catch (error) {
        console.error(`Error processing ${file}:`, error);
      }
    }
    
    return questions;
  }

  formatQuestionsForOutput(questions: MCQQuestion[]): string {
    let output = `Multiple Choice Questions Extracted from PNG Images (OCR)\n`;
    output += `Generated on: ${new Date().toISOString()}\n`;
    output += `Total Questions: ${questions.length}\n`;
    output += `${'='.repeat(80)}\n\n`;
    
    questions.forEach((q, index) => {
      output += `QUESTION ${index + 1}\n`;
      output += `ID: ${q.questionId}\n`;
      output += `Source: ${q.filename}\n`;
      output += `${'─'.repeat(40)}\n`;
      output += `Q: ${q.question}\n\n`;
      
      q.options.forEach(option => {
        output += `${option.id}) ${option.text}\n\n`;
      });
      
      output += `${'='.repeat(80)}\n\n`;
    });
    
    // Add summary section
    output += `SUMMARY\n`;
    output += `${'='.repeat(80)}\n`;
    output += `Questions processed: ${questions.length}\n`;
    output += `Files processed: ${questions.map(q => q.filename).join(', ')}\n\n`;
    output += `This text file contains all extracted multiple choice questions using OCR.\n`;
    output += `Upload this file to an AI chatbot for analysis and processing.\n`;
    
    // Add technical notes
    output += `\nTECHNICAL NOTES:\n`;
    output += `- Extracted using Tesseract OCR v5.x\n`;
    output += `- Text parsing includes error correction for common OCR artifacts\n`;
    output += `- Questions with insufficient text or options are filtered out\n`;
    
    return output;
  }

  formatQuestionsAsJSON(questions: MCQQuestion[]): string {
    const output = {
      metadata: {
        generatedOn: new Date().toISOString(),
        totalQuestions: questions.length,
        extractionMethod: "OCR (Tesseract v5.x)",
        filesProcessed: questions.map(q => q.filename)
      },
      questions: questions.map((q, index) => ({
        questionNumber: index + 1,
        questionId: q.questionId,
        sourceFile: q.filename,
        questionText: q.question,
        options: q.options.map(opt => ({
          id: opt.id,
          text: opt.text
        })),
        metadata: {
          hasRawText: !!q.rawText,
          optionCount: q.options.length
        }
      })),
      technicalNotes: [
        "Extracted using Tesseract OCR v5.x",
        "Text parsing includes error correction for common OCR artifacts",
        "Questions with insufficient text or options are filtered out"
      ]
    };
    
    return JSON.stringify(output, null, 2);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const targetDirectory = args[0] || './docs';
  const outputFile = args[1] || './extracted-questions-ocr.txt';
  
  if (!fs.existsSync(targetDirectory)) {
    console.error(`Directory "${targetDirectory}" does not exist.`);
    process.exit(1);
  }
  
  const extractor = new OCRMCQExtractor();
  
  try {
    console.log(`Processing PNG files in: ${targetDirectory}`);
    console.log(`Using system Tesseract OCR...`);
    
    const questions = await extractor.processDirectory(targetDirectory);
    
    if (questions.length > 0) {
      const formattedOutput = extractor.formatQuestionsForOutput(questions);
      fs.writeFileSync(outputFile, formattedOutput, 'utf8');
      
      // Also generate JSON output
      const jsonOutput = extractor.formatQuestionsAsJSON(questions);
      const jsonFile = outputFile.replace(/\.txt$/, '.json');
      fs.writeFileSync(jsonFile, jsonOutput, 'utf8');
      
      // Generate raw OCR output file
      const orgFile = outputFile.replace(/\.txt$/, '.org.txt');
      let rawOcrOutput = `Raw OCR Text Output\n`;
      rawOcrOutput += `Generated on: ${new Date().toISOString()}\n`;
      rawOcrOutput += `Total Files Processed: ${questions.length}\n`;
      rawOcrOutput += `${'='.repeat(80)}\n\n`;
      
      questions.forEach((q, index) => {
        rawOcrOutput += `FILE ${index + 1}: ${q.filename}\n`;
        rawOcrOutput += `${'─'.repeat(40)}\n`;
        rawOcrOutput += `${q.rawText || 'No raw text available'}\n\n`;
        rawOcrOutput += `${'='.repeat(80)}\n\n`;
      });
      
      fs.writeFileSync(orgFile, rawOcrOutput, 'utf8');
      
      console.log(`\n✓ Successfully extracted ${questions.length} questions using OCR`);
      console.log(`✓ Text output saved to: ${outputFile}`);
      console.log(`✓ JSON output saved to: ${jsonFile}`);
      console.log(`✓ Raw OCR output saved to: ${orgFile}`);
      console.log(`\nYou can upload any of these files to an AI chatbot for analysis.`);
    } else {
      console.log('No questions were successfully extracted.');
    }
    
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(console.error);
}
